import { createHash, createPrivateKey, randomInt, randomUUID } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import {
  PREMIUM_BUNDLE,
  PREMIUM_FEATURES,
  featuresOf,
  type GrantKind,
  type PremiumGrantScope,
} from "@dragon-control/core";
import type { Session } from "../auth/service";
import type { Vault } from "../auth/vault";
import type { DbHandle } from "../db/client";
import { withTransaction } from "../db/tx";
import * as t from "../db/schema";
import { recordAudit } from "../store/audit";
import { getSetting, setSetting } from "../store/settings";
import { ConflictError, NotFoundError } from "../store/errors";
import { keyIdOf, newSigningKey, publicOf, signLicense, type TrustedKeys } from "./license";
import { LicenceServiceError, type LicenceService } from "./service";

/**
 * The owner's grants and promo codes (docs/design/PREMIUM.md). Only a Hearth holding the owner's
 * signing key can issue: the key lives in its Secure Vault as a protected secret, so every licence
 * it signs needs the owner signed in with the vault unlocked. A Hearth whose key is not one that
 * Hearth's releases trust can't issue anything anyone accepts, so a local administrator on any
 * other installation can't mint licences.
 *
 * Complimentary grants cost nothing and need no card: they are not subscriptions and never renew.
 */

export const AUDIENCES = [
  "self",
  "family",
  "friend",
  "creator",
  "tester",
  "partner",
  "other",
] as const;
export type Audience = (typeof AUDIENCES)[number];

export class IssuerError extends ConflictError {}

/** Crockford base32: no I, L, O or U, so a code read aloud or typed is hard to get wrong. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** HRTH- and 20 letters (100 bits): guessing one is hopeless. */
export function newCode(): string {
  let s = "";
  for (let i = 0; i < 20; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `HRTH-${s.match(/.{5}/g)!.join("-")}`;
}
/** How a typed code is compared: upper case, no spaces or dashes, look-alike letters folded. */
export const normalizeCode = (code: string) =>
  code
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/^HRTH(?=.{20}$)/, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
const hashOf = (code: string) =>
  createHash("sha256")
    .update(`hearth-promo:${normalizeCode(code)}`)
    .digest("hex");

export interface IssuerSetting {
  secretId: string;
  publicKey: string;
  keyId: string;
}

export interface GrantInput {
  recipient: string;
  audience: Audience;
  note?: string;
  scope: PremiumGrantScope[];
  kind?: GrantKind;
  /** ISO; default now. */
  start?: string;
  /** ISO; absent: for good. */
  end?: string;
  /** The recipient's installation id (from their Settings, Premium). */
  installId?: string;
  /** A short label the recipient sees. */
  label?: string;
}

export interface CodeInput {
  scope: PremiumGrantScope[];
  campaign?: string;
  audience: Audience;
  note?: string;
  /** How long the grant lasts once redeemed; absent: for good. */
  durationDays?: number;
  /** The last moment the code can be redeemed. */
  expiresAt?: string;
  maxUses: number;
}

/** Tries per installation (or signed-in person) before redemption waits a while. */
const TRIES = { perMinute: 5, perHour: 20 };

export class Issuer {
  private tries = new Map<string, number[]>();
  /** Hearth's licence service: codes and revocations reach every Hearth through it. */
  private service?: LicenceService;

  constructor(
    private readonly handle: DbHandle,
    private readonly vault: Vault,
    private readonly installId: () => Promise<string>,
    private readonly trusted: () => Promise<TrustedKeys>,
    /** Licences for this installation go straight into its own entitlements. */
    private readonly installHere: (token: string) => Promise<unknown>,
    private readonly clock: () => number = Date.now,
  ) {}

  private get db() {
    return this.handle.db;
  }

  connect(service: LicenceService | undefined) {
    this.service = service;
  }

  /** The vault's signing key (the owner's unlocked session), checked against this Hearth's. */
  private async privateKey(session: Session, why: string) {
    const s = await this.setting();
    if (!s || !(await this.active()))
      throw new IssuerError("This Hearth can't issue licences: it has no trusted signing key.");
    const pem = await this.vault.use(s.secretId, why, {
      actor: "dragon-control",
      unlockedSession: session,
    });
    if (keyIdOf(publicOf(pem)) !== s.keyId)
      throw new IssuerError("The signing key in the vault isn't the one this Hearth set up.");
    return pem;
  }

  /** Tells the licence service, signed with the owner's key. Nothing to do without one. */
  private async tell(session: Session | undefined, body: Record<string, unknown>, failed: string) {
    if (!this.service) return;
    if (!session) throw new IssuerError("Sign in as the owner to change Premium codes.");
    const pem = await this.privateKey(session, "tell Hearth's licence service about a change");
    try {
      await this.service.owner(pem, body);
    } catch (e) {
      if (e instanceof LicenceServiceError) throw new IssuerError(`${failed} ${e.message}`);
      throw e;
    }
  }

  async setting(): Promise<IssuerSetting | undefined> {
    return getSetting(this.db, "premium_issuer");
  }

  /** This Hearth holds a signing key that Hearth trusts: it can issue. */
  async active(): Promise<boolean> {
    const s = await this.setting();
    if (!s || !(await this.vault.exists(s.secretId))) return false;
    return (await this.trusted())[s.keyId] === s.publicKey;
  }

  /**
   * Makes the signing key (the owner, once, on the Hearth that will issue). Its private half goes
   * into the vault as a protected secret; the public half is what a release must trust before
   * anyone accepts its licences.
   */
  async setUp(): Promise<{ publicKey: string; keyId: string }> {
    const had = await this.setting();
    if (had && (await this.vault.exists(had.secretId)))
      throw new IssuerError("This Hearth already has a signing key.");
    const key = newSigningKey();
    const added = await this.vault.add({
      name: "Hearth licence signing key",
      kind: "other",
      tier: "protected",
      value: key.privatePem,
      notes:
        "Signs Hearth Premium licences and promo-code grants. Keep a copy somewhere safe and offline: without it, no new licences can be issued under this key.",
      source: "Hearth",
      actor: "dragon-control",
    });
    await setSetting(this.db, "premium_issuer", {
      secretId: added.id,
      publicKey: key.publicKey,
      keyId: key.keyId,
    });
    await recordAudit(this.db, {
      actor: "you",
      action: `Made the Hearth licence signing key (${key.keyId})`,
      target: "premium",
    });
    return { publicKey: key.publicKey, keyId: key.keyId };
  }

  /** This Hearth set up a signing key, but it is no longer in the vault (a lost or reset vault). */
  async keyMissing(): Promise<boolean> {
    const s = await this.setting();
    return Boolean(s) && !(await this.vault.exists(s!.secretId));
  }

  /**
   * Uses a signing key the owner saved (their offline copy, docs PREMIUM_SIGNING_KEY.md) on a
   * Hearth that has none, or whose vault lost it. Its public half and key id are unchanged, so
   * every licence it signed keeps working and no release is needed. A Hearth that set up a key
   * before takes only that same key back.
   */
  async restore(saved: string): Promise<{ publicKey: string; keyId: string; trusted: boolean }> {
    const pem = saved.trim();
    let publicKey: string;
    try {
      if (createPrivateKey(pem).asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
      publicKey = publicOf(pem);
    } catch {
      throw new IssuerError(
        "That isn't a Hearth licence signing key. Paste the whole saved text, from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----.",
      );
    }
    const keyId = keyIdOf(publicKey);
    const had = await this.setting();
    if (had && (await this.vault.exists(had.secretId)))
      throw new IssuerError("This Hearth already has a signing key.");
    if (had && had.keyId !== keyId)
      throw new IssuerError(
        `That is a different key (key id ${keyId}). This Hearth's signing key is ${had.keyId}.`,
      );
    const added = await this.vault.add({
      name: "Hearth licence signing key",
      kind: "other",
      tier: "protected",
      value: pem,
      notes:
        "Signs Hearth Premium licences and promo-code grants. Restored from a saved copy. Keep that copy somewhere safe and offline.",
      source: "Hearth",
      actor: "dragon-control",
    });
    await setSetting(this.db, "premium_issuer", { secretId: added.id, publicKey, keyId });
    await recordAudit(this.db, {
      actor: "you",
      action: `Restored the Hearth licence signing key from a saved copy (${keyId})`,
      target: "premium",
    });
    return { publicKey, keyId, trusted: (await this.trusted())[keyId] === publicKey };
  }

  /** Signs a licence with the vault's key (the owner's unlocked session). */
  private async sign(
    session: Session,
    p: {
      id: string;
      install: string;
      scope: string[];
      kind: GrantKind;
      start: string;
      end?: string | null;
      label?: string;
    },
  ) {
    const pem = await this.privateKey(session, "sign a Hearth Premium licence");
    return signLicense(
      {
        id: p.id,
        install: p.install,
        features: featuresOf(p.scope as PremiumGrantScope[]),
        kind: p.kind,
        start: p.start,
        ...(p.end ? { end: p.end } : {}),
        issued: new Date(this.clock()).toISOString(),
        ...(p.label ? { label: p.label } : {}),
      },
      pem,
    );
  }

  private checkScope(scope: string[]) {
    if (
      !scope.length ||
      !scope.every(
        (s) => s === PREMIUM_BUNDLE || (PREMIUM_FEATURES as readonly string[]).includes(s),
      )
    )
      throw new IssuerError("Choose which premium features it gives.");
  }

  /**
   * A direct grant: for you, family, friends, creators, testers or partners, $0 and no card. With
   * the recipient's installation id, it comes back as a licence key to send them (shown once); for
   * this installation, it applies at once.
   */
  async grant(
    session: Session,
    input: GrantInput,
  ): Promise<{ grantId: string; licenseKey?: string }> {
    this.checkScope(input.scope);
    const start = input.start ?? new Date(this.clock()).toISOString();
    if (input.end && Date.parse(input.end) <= Date.parse(start))
      throw new IssuerError("The end has to come after the start.");
    const id = randomUUID();
    const licenseId = randomUUID();
    let licenseKey: string | undefined;
    if (input.installId)
      licenseKey = await this.sign(session, {
        id: licenseId,
        install: input.installId,
        scope: input.scope,
        kind: input.kind ?? "complimentary",
        start,
        ...(input.end ? { end: input.end } : {}),
        ...(input.label ? { label: input.label } : {}),
      });
    await this.db.insert(t.premiumGrants).values({
      id,
      recipient: input.recipient,
      audience: input.audience,
      note: input.note ?? null,
      scope: input.scope,
      kind: input.kind ?? "complimentary",
      startsAt: start,
      endsAt: input.end ?? null,
      installId: input.installId ?? null,
      licenseId: input.installId ? licenseId : null,
    });
    await recordAudit(this.db, {
      actor: "you",
      action: `Granted Premium (${input.scope.join(", ")}) to ${input.recipient}${input.end ? ` until ${input.end.slice(0, 10)}` : ", for good"}`,
      target: `premium-grant:${id}`,
    });
    if (licenseKey && input.installId === (await this.installId()))
      await this.installHere(licenseKey);
    return { grantId: id, ...(licenseKey ? { licenseKey } : {}) };
  }

  /** Takes a grant back: its licence stops counting wherever the issuer's word reaches. */
  async revoke(id: string, session?: Session) {
    const row = await this.db
      .select()
      .from(t.premiumGrants)
      .where(eq(t.premiumGrants.id, id))
      .get();
    if (!row) throw new NotFoundError("No such grant.");
    await this.db
      .update(t.premiumGrants)
      .set({ status: "revoked", revokedAt: new Date(this.clock()).toISOString() })
      .where(eq(t.premiumGrants.id, id));
    await recordAudit(this.db, {
      actor: "you",
      action: `Revoked the Premium grant for ${row.recipient}`,
      target: `premium-grant:${id}`,
    });
    if (row.licenseId)
      await this.tell(
        session,
        { op: "revoke", ids: [row.licenseId] },
        "Taken back on this Hearth, but other Hearths don't know yet: press Revoke again in a minute.",
      );
  }

  /** Gives a revoked grant back. */
  async reinstate(id: string, session?: Session) {
    const row = await this.db
      .select()
      .from(t.premiumGrants)
      .where(eq(t.premiumGrants.id, id))
      .get();
    if (!row) throw new NotFoundError("No such grant.");
    await this.db
      .update(t.premiumGrants)
      .set({ status: "active", revokedAt: null })
      .where(eq(t.premiumGrants.id, id));
    await recordAudit(this.db, {
      actor: "you",
      action: `Reinstated the Premium grant for ${row.recipient}`,
      target: `premium-grant:${id}`,
    });
    if (row.licenseId)
      await this.tell(
        session,
        { op: "unrevoke", id: row.licenseId },
        "Given back on this Hearth, but other Hearths don't know yet: press Reinstate again in a minute.",
      );
  }

  /**
   * Takes back every licence made from a code (redeemed anywhere), and switches the code off so
   * no new ones are made.
   */
  async revokeCode(id: string, session?: Session) {
    const row = await this.db.select().from(t.premiumCodes).where(eq(t.premiumCodes.id, id)).get();
    if (!row) throw new NotFoundError("No such code.");
    await this.tell(session, { op: "code-active", id, active: false }, "Nothing was changed.");
    await this.tell(
      session,
      { op: "revoke-code", id },
      "The code is off, but its licences weren't taken back yet: try again in a minute.",
    );
    const now = new Date(this.clock()).toISOString();
    await this.db.update(t.premiumCodes).set({ active: false }).where(eq(t.premiumCodes.id, id));
    await this.db
      .update(t.premiumGrants)
      .set({ status: "revoked", revokedAt: now })
      .where(eq(t.premiumGrants.codeId, id));
    await recordAudit(this.db, {
      actor: "you",
      action: `Took back every licence made from the Premium code ${row.hint}…`,
      target: `premium-code:${id}`,
    });
  }

  /** The licences this issuer took back (what an installation asks about). */
  async revokedLicenses(ids?: string[]): Promise<string[]> {
    const rows = await this.db
      .select({ licenseId: t.premiumGrants.licenseId })
      .from(t.premiumGrants)
      .where(eq(t.premiumGrants.status, "revoked"));
    const all = rows.map((r) => r.licenseId).filter((x): x is string => Boolean(x));
    return ids ? all.filter((x) => ids.includes(x)) : all;
  }

  /** A promo code: shown once here, only its hash kept. */
  async createCode(input: CodeInput, session?: Session): Promise<{ id: string; code: string }> {
    this.checkScope(input.scope);
    if (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > 10_000)
      throw new IssuerError("Uses: from 1 to 10,000.");
    const code = newCode();
    const id = randomUUID();
    // The licence service first: a code it doesn't know would work nowhere but here.
    await this.tell(
      session,
      {
        op: "code",
        code: {
          id,
          hash: hashOf(code),
          features: featuresOf(input.scope),
          maxUses: input.maxUses,
          ...(input.durationDays ? { days: input.durationDays } : {}),
          ...(input.expiresAt ? { redeemBy: input.expiresAt } : {}),
          ...(input.campaign ? { label: input.campaign } : {}),
          active: true,
        },
      },
      "The code wasn't made.",
    );
    await this.db.insert(t.premiumCodes).values({
      id,
      hash: hashOf(code),
      hint: code.slice(0, 10),
      campaign: input.campaign ?? null,
      audience: input.audience,
      note: input.note ?? null,
      scope: input.scope,
      durationDays: input.durationDays ?? null,
      expiresAt: input.expiresAt ?? null,
      maxUses: input.maxUses,
    });
    await recordAudit(this.db, {
      actor: "you",
      action: `Made a Premium code ${code.slice(0, 10)}… (${input.scope.join(", ")}, ${input.maxUses} use${input.maxUses === 1 ? "" : "s"})`,
      target: `premium-code:${id}`,
    });
    return { id, code };
  }

  /** Stops a code being redeemed. Grants already made from it stay (revoke those separately). */
  async setCodeActive(id: string, active: boolean, session?: Session) {
    const row = await this.db.select().from(t.premiumCodes).where(eq(t.premiumCodes.id, id)).get();
    if (!row) throw new NotFoundError("No such code.");
    await this.tell(session, { op: "code-active", id, active }, "Nothing was changed.");
    await this.db.update(t.premiumCodes).set({ active }).where(eq(t.premiumCodes.id, id));
    await recordAudit(this.db, {
      actor: "you",
      action: `${active ? "Reactivated" : "Deactivated"} the Premium code ${row.hint}…`,
      target: `premium-code:${id}`,
    });
  }

  private limited(who: string) {
    const now = this.clock();
    const list = (this.tries.get(who) ?? []).filter((x) => now - x < 3_600_000);
    if (
      list.filter((x) => now - x < 60_000).length >= TRIES.perMinute ||
      list.length >= TRIES.perHour
    )
      throw new IssuerError("Too many tries. Wait a few minutes, then try the code again.");
    list.push(now);
    this.tries.set(who, list);
  }

  /**
   * Redeems a code for an installation: once per installation, never past its uses, even when
   * several screens redeem at the same moment (the count is claimed in one step).
   */
  async redeem(
    session: Session,
    code: string,
    installId: string,
  ): Promise<{ licenseKey: string; grantId: string }> {
    this.limited(installId);
    const row = await this.db
      .select()
      .from(t.premiumCodes)
      .where(eq(t.premiumCodes.hash, hashOf(code)))
      .get();
    const now = this.clock();
    if (!row) throw new IssuerError("That code isn't right. Check it and try again.");
    if (!row.active) throw new IssuerError("That code has been switched off.");
    if (row.expiresAt && now >= Date.parse(row.expiresAt))
      throw new IssuerError("That code has expired.");
    const grantId = randomUUID();
    const licenseId = randomUUID();
    const start = new Date(now).toISOString();
    const end = row.durationDays
      ? new Date(now + row.durationDays * 86_400_000).toISOString()
      : undefined;
    // Sign first (it may need the vault), then claim a use and record it in one transaction.
    const licenseKey = await this.sign(session, {
      id: licenseId,
      install: installId,
      scope: row.scope,
      kind: "complimentary",
      start,
      ...(end ? { end } : {}),
      ...(row.campaign ? { label: row.campaign } : {}),
    });
    await withTransaction(this.handle, async () => {
      const used = await this.db
        .select()
        .from(t.premiumRedemptions)
        .where(
          and(
            eq(t.premiumRedemptions.codeId, row.id),
            eq(t.premiumRedemptions.installId, installId),
          ),
        )
        .get();
      if (used) throw new IssuerError("This installation already redeemed that code.");
      // Read again inside the transaction (they run one at a time), then claim a use only while
      // one is left: never past the limit, however many redeem at once.
      const fresh = await this.db
        .select()
        .from(t.premiumCodes)
        .where(eq(t.premiumCodes.id, row.id))
        .get();
      if (!fresh?.active) throw new IssuerError("That code has been switched off.");
      if (fresh.uses >= fresh.maxUses) throw new IssuerError("That code has been used up.");
      const claimed = await this.db
        .update(t.premiumCodes)
        .set({ uses: fresh.uses + 1 })
        .where(and(eq(t.premiumCodes.id, row.id), lt(t.premiumCodes.uses, fresh.maxUses)))
        .returning({ id: t.premiumCodes.id });
      if (!claimed.length) throw new IssuerError("That code has been used up.");
      await this.db
        .insert(t.premiumRedemptions)
        .values({ id: randomUUID(), codeId: row.id, installId, grantId });
      await this.db.insert(t.premiumGrants).values({
        id: grantId,
        recipient: `Code ${row.hint}…`,
        audience: row.audience,
        scope: row.scope,
        kind: "complimentary",
        startsAt: start,
        endsAt: end ?? null,
        installId,
        licenseId,
        codeId: row.id,
      });
    });
    await recordAudit(this.db, {
      actor: "you",
      action: `Redeemed the Premium code ${row.hint}… for installation ${installId.slice(0, 8)}`,
      target: `premium-code:${row.id}`,
    });
    if (installId === (await this.installId())) await this.installHere(licenseKey);
    return { licenseKey, grantId };
  }

  /** The owner's lists (notes included: only the owner sees these). */
  async overview() {
    const [grants, codes] = await Promise.all([
      this.db.select().from(t.premiumGrants).orderBy(desc(t.premiumGrants.createdAt)).limit(500),
      this.db.select().from(t.premiumCodes).orderBy(desc(t.premiumCodes.createdAt)).limit(500),
    ]);
    const now = this.clock();
    // With the licence service, it counts the uses (codes are redeemed there, from any Hearth).
    if (this.service) {
      const counted = await Promise.allSettled(codes.map((c) => this.service!.codeUses(c.id)));
      counted.forEach((r, i) => {
        if (r.status === "fulfilled") codes[i] = { ...codes[i]!, uses: r.value.uses };
      });
    }
    return {
      grants: grants.map((g) => ({
        ...g,
        state:
          g.status === "revoked"
            ? "revoked"
            : g.endsAt && now >= Date.parse(g.endsAt)
              ? "expired"
              : now < Date.parse(g.startsAt)
                ? "scheduled"
                : "active",
      })),
      codes: codes.map(({ hash: _hash, ...c }) => ({
        ...c,
        remaining: Math.max(0, c.maxUses - c.uses),
        state: !c.active
          ? "off"
          : c.expiresAt && now >= Date.parse(c.expiresAt)
            ? "expired"
            : c.uses >= c.maxUses
              ? "used up"
              : "active",
      })),
    };
  }
}
