import {
  licenceCovers,
  PREMIUM_FEATURES,
  PREMIUM_INFO,
  type EntitlementState,
  type FeatureAccess,
  type PremiumFeature,
  type PremiumStatus,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import { getSetting, setSetting } from "../store/settings";
import {
  LicenseError,
  peekId,
  readLicense,
  type LicensePayload,
  type TrustedKeys,
} from "./license";

/**
 * The one place Hearth decides whether this installation has a premium feature
 * (docs/design/PREMIUM.md). Every premium action asks `require` at the server, where the action
 * happens; the page only mirrors it. A licence that ends or is taken back stops new premium
 * actions and nothing else: links, settings, data and backups are kept, and every Hearth goes on
 * working on its own.
 */

/**
 * 402: a licence is needed. Not 403, which the page reads as "confirm it's you"; and never a
 * claim that anything is for sale.
 */
export class PremiumRequiredError extends Error {
  override name = "PremiumRequired";
  readonly statusCode = 402;
  constructor(
    readonly feature: PremiumFeature,
    what: string,
  ) {
    super(
      `${what} is part of ${PREMIUM_INFO[feature].name}, which this Hearth doesn't have. Everything you already set up is kept. See Settings, Premium.`,
    );
  }
}

/** What Hearth keeps about its licences (settings key "premium"). */
export interface PremiumState {
  /** The licence keys installed here. */
  licenses: string[];
  /** Licences the issuer says were taken back (their ids). */
  revoked: string[];
  /** The latest time this Hearth has seen: a clock set back before it can't stretch a licence. */
  highWater?: string;
  /** When the issuer was last asked about revocations. */
  checkedAt?: string;
  /**
   * Licences shared by the Hearths this one is linked to, by where they came from ("hub", or
   * "pc:<id>"). Premium is bought once per person (the owner, 11-20: "pay premium once and
   * connect all three"), so a licence on any linked Hearth counts on all of them.
   */
  linked?: Record<string, string[]>;
}

/** How far behind the clock may be before dated licences wait (time zones, small drift). */
const CLOCK_SLACK_MS = 36 * 3_600_000;
const RANK: EntitlementState[] = ["active", "pending", "scheduled", "expired", "revoked", "free"];

export function stateOf(
  p: LicensePayload,
  now: number,
  revoked: ReadonlySet<string>,
  highWater?: string,
): EntitlementState {
  if (revoked.has(p.id)) return "revoked";
  const behind = highWater ? now < Date.parse(highWater) - CLOCK_SLACK_MS : false;
  if (behind && p.end) return "pending";
  if (now < Date.parse(p.start)) return "scheduled";
  if (p.end && now >= Date.parse(p.end)) return "expired";
  return "active";
}

export class Entitlements {
  constructor(
    private readonly handle: DbHandle,
    private readonly installId: () => Promise<string>,
    /** The keys licences may be signed with (production keys, plus the test issuer in tests). */
    private readonly trusted: () => Promise<TrustedKeys>,
    /** Revocations the issuer on this Hearth knows directly (the owner's own installation). */
    private readonly localRevocations: () => Promise<string[]> = async () => [],
    private readonly clock: () => number = Date.now,
    /** Premium's locks are on (false before launch: every premium feature is open). */
    private readonly enforced: () => boolean = () => true,
  ) {}

  async state(): Promise<PremiumState> {
    return { licenses: [], revoked: [], ...((await getSetting(this.handle.db, "premium")) ?? {}) };
  }

  private async save(s: PremiumState) {
    await setSetting(this.handle.db, "premium", s);
  }

  /** Told when this Hearth's own licences change, so linked Hearths can be brought up to date. */
  onChange?: () => void;

  /** The licences here that are genuine: this installation's own, then the linked Hearths'. */
  private async valid(): Promise<LicensePayload[]> {
    const s = await this.state();
    const keys = await this.trusted();
    const install = await this.installId();
    const out: LicensePayload[] = [];
    const seen = new Set<string>();
    const take = (token: string, own: boolean) => {
      try {
        const p = readLicense(token, keys);
        if (own && p.install !== install) return;
        if (seen.has(p.id)) return;
        seen.add(p.id);
        out.push(p);
      } catch {
        // A licence that no longer checks out (a key Hearth stopped trusting) counts for nothing.
      }
    };
    for (const token of s.licenses) take(token, true);
    // A linked Hearth's licence is genuine (signed) and bound to that Hearth: it counts here too.
    for (const tokens of Object.values(s.linked ?? {}))
      for (const token of tokens) take(token, false);
    return out;
  }

  /** This installation's own genuine licence keys (what it shares with the Hearths it links to). */
  async own(): Promise<string[]> {
    const s = await this.state();
    const keys = await this.trusted();
    const install = await this.installId();
    return s.licenses.filter((token) => {
      try {
        return readLicense(token, keys).install === install;
      } catch {
        return false;
      }
    });
  }

  /** Every genuine licence key this Hearth counts, its own and its linked Hearths' (shared down). */
  async shareable(): Promise<string[]> {
    const s = await this.state();
    const all = [...(await this.own()), ...Object.values(s.linked ?? {}).flat()];
    const keys = await this.trusted();
    const out = new Map<string, string>();
    for (const token of all) {
      try {
        const id = readLicense(token, keys).id;
        if (!out.has(id)) out.set(id, token);
      } catch {
        // Not one this Hearth trusts: not passed on.
      }
    }
    return [...out.values()].slice(0, 40);
  }

  /** Keeps what a linked Hearth shared (an empty list forgets it: unlinked, or none left). */
  async setLinked(source: string, tokens: string[]) {
    const s = await this.state();
    const linked = { ...(s.linked ?? {}) };
    const clean = tokens
      .filter((t) => typeof t === "string" && t.length < 4000)
      .map((t) => t.trim())
      .slice(0, 40);
    if (clean.length) linked[source] = clean;
    else delete linked[source];
    const before = JSON.stringify(s.linked ?? {});
    if (JSON.stringify(linked) === before) return false;
    await this.save({ ...s, linked });
    return true;
  }

  /** Moves the clock's high-water mark on (at most once a minute is written). */
  private async observe(s: PremiumState) {
    const now = this.clock();
    if (!s.highWater || now - Date.parse(s.highWater) > 60_000) {
      if (s.highWater && now < Date.parse(s.highWater)) return s;
      const next = { ...s, highWater: new Date(now).toISOString() };
      await this.save(next);
      return next;
    }
    return s;
  }

  async status(issuer: boolean, redeemOnline: boolean): Promise<PremiumStatus> {
    const s = await this.observe(await this.state());
    const revoked = new Set([...s.revoked, ...(await this.localRevocations())]);
    const now = this.clock();
    const licenses = (await this.valid()).map((p) => ({
      p,
      state: stateOf(p, now, revoked, s.highWater),
    }));
    const open = !this.enforced();
    const features: FeatureAccess[] = PREMIUM_FEATURES.map((feature) => {
      if (open) return { feature, state: "active" };
      const best = licenses
        .filter((l) => licenceCovers(l.p.features, feature))
        .sort(
          (a, b) =>
            RANK.indexOf(a.state) - RANK.indexOf(b.state) ||
            // The one lasting longest first (no end beats any end).
            (b.p.end ? Date.parse(b.p.end) : Infinity) - (a.p.end ? Date.parse(a.p.end) : Infinity),
        )[0];
      return best
        ? {
            feature,
            state: best.state,
            kind: best.p.kind,
            licenseId: best.p.id,
            start: best.p.start,
            ...(best.p.end ? { end: best.p.end } : {}),
          }
        : { feature, state: "free" };
    });
    return {
      installId: await this.installId(),
      ...(open ? { open: true } : {}),
      features,
      issuer,
      redeemOnline,
      licenses: licenses.map(({ p, state }) => ({
        id: p.id,
        features: p.features,
        kind: p.kind,
        start: p.start,
        ...(p.end ? { end: p.end } : {}),
        state,
        ...(p.label ? { label: p.label } : {}),
      })),
    };
  }

  /**
   * A licence key installed here that gives the feature now (for a service that checks it
   * itself, such as panel donations). The newest-ending one; none in open mode without licences.
   */
  async tokenFor(feature: PremiumFeature): Promise<string | undefined> {
    const s = await this.state();
    const keys = await this.trusted();
    const install = await this.installId();
    const now = this.clock();
    let best: { token: string; end: number } | undefined;
    for (const token of s.licenses) {
      try {
        const p = readLicense(token, keys);
        const end = p.end ? Date.parse(p.end) : Infinity;
        if (
          p.install !== install ||
          !p.features.includes(feature) ||
          s.revoked.includes(p.id) ||
          Date.parse(p.start) > now ||
          end < now
        )
          continue;
        if (!best || end > best.end) best = { token, end };
      } catch {
        // Not one this Hearth trusts any more.
      }
    }
    return best?.token;
  }

  /** Whether this installation has the feature right now. */
  async has(feature: PremiumFeature): Promise<boolean> {
    const st = await this.status(false, false);
    return st.features.find((f) => f.feature === feature)?.state === "active";
  }

  /** The gate every premium action passes: throws a plain, non-destructive refusal. */
  async require(feature: PremiumFeature, what: string): Promise<void> {
    if (!(await this.has(feature))) throw new PremiumRequiredError(feature, what);
  }

  /** Installs a licence key: it must be genuine and for this installation. */
  async install(token: string): Promise<LicensePayload> {
    const p = readLicense(token, await this.trusted());
    if (p.install !== (await this.installId()))
      throw new LicenseError(
        "That licence is for a different Hearth installation. Ask for one made for this installation's ID (Settings, Premium).",
      );
    const s = await this.state();
    const others = s.licenses.filter((t) => peekId(t) !== p.id);
    await this.save({ ...s, licenses: [...others, token.trim()].slice(-20) });
    this.onChange?.();
    return p;
  }

  /** The issuer's word on which licences were taken back (an online check, when there is one). */
  async markRevoked(ids: string[], at = new Date(this.clock()).toISOString()) {
    const s = await this.state();
    await this.save({ ...s, revoked: [...new Set([...s.revoked, ...ids])], checkedAt: at });
  }

  /**
   * The licence service's list of licences taken back: only the ones installed here count, and a
   * licence given back (no longer listed) counts again.
   */
  async syncRevoked(ids: string[], at = new Date(this.clock()).toISOString()) {
    const s = await this.state();
    const here = new Set(
      [...s.licenses, ...Object.values(s.linked ?? {}).flat()]
        .map((t) => peekId(t))
        .filter(Boolean),
    );
    await this.save({ ...s, revoked: ids.filter((id) => here.has(id)), checkedAt: at });
  }

  /** The issuer gave a licence back (reinstated). */
  async unrevoke(id: string) {
    const s = await this.state();
    await this.save({ ...s, revoked: s.revoked.filter((r) => r !== id) });
  }

  /** The licence ids installed here (to ask the issuer about). */
  async ids(): Promise<string[]> {
    return (await this.valid()).map((p) => p.id);
  }
}
