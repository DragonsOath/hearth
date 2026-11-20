/**
 * Hearth Premium (11-05, HEARTH_PREMIUM_ENTITLEMENTS_DC_SPEC): Hearth is free for ordinary
 * homelab use. Three capabilities are premium, and this catalog is the only place they are named.
 * (Hearth Transfer was one, 11-07 to 11-11, then removed; Curator For You was one, 11-13 to 11-14,
 * then made free.) Everything else (every panel, widget, dashboard, Docker and media
 * administration, Home Assistant, normal Ember chat, diagnosis, actions and verification, Ember's
 * Browser, all of Curator, phones and tablets signed in to one Hearth, NAS and remote services,
 * Hearth's own panel for every app, basic panels and "Request it") is free, with no usage limits.
 * Anything custom (building, loading, sharing a custom panel, skins) is Panel Builder.
 */

export const PREMIUM_FEATURES = [
  "hearth_interconnectivity",
  "ember_show_and_tell",
  "panel_builder",
] as const;
export type PremiumFeature = (typeof PREMIUM_FEATURES)[number];

/** A grant may name features one by one, or the bundle (every premium feature). */
export const PREMIUM_BUNDLE = "premium_all";
export type PremiumGrantScope = PremiumFeature | typeof PREMIUM_BUNDLE;

export const PREMIUM_INFO: Record<PremiumFeature, { name: string; what: string; free: string }> = {
  hearth_interconnectivity: {
    name: "Hearth Connected",
    what: "Link two or more Hearth installations and run them as one: add a PC to your Hearth, open its Lair, War Room and storage from any of them, and have Ember work across them.",
    free: "Every Hearth works fully on its own, free, on as many computers as you like. Reaching apps, Docker hosts, a NAS or Home Assistant on another machine is free too.",
  },
  ember_show_and_tell: {
    name: "Ember Show & Tell",
    what: "Ember opens what she is working on and points at it on your screen as she goes, with captions and Teach me mode.",
    free: "Talking to Ember, her diagnosis, fixes you approve, verification, memory and Ember's Browser are free.",
  },
  panel_builder: {
    name: "Panel Builder",
    what: "Custom panels: Ember builds one for an app with you, you load panels other people shared, and you keep yours private or donate it.",
    free: "Hearth's own panel for every app, basic panels, and Request it for any app are free.",
  },
};

/**
 * All of Premium as first issued (11-05 to 11-13). A licence naming both was issued as all of
 * Premium, so it covers every feature added since (Panel Builder included).
 */
export const PREMIUM_ALL_ORIGINAL: readonly PremiumFeature[] = [
  "hearth_interconnectivity",
  "ember_show_and_tell",
];

/** Whether a licence's features give this one (see PREMIUM_ALL_ORIGINAL). */
export function licenceCovers(features: readonly string[], feature: PremiumFeature): boolean {
  return features.includes(feature) || PREMIUM_ALL_ORIGINAL.every((f) => features.includes(f));
}

/** Where Premium is bought: Dragon's Oath on GitHub Sponsors (2026-11-13). */
export const SPONSORS_URL = "https://github.com/sponsors/DragonsOath";
/**
 * Whether the Sponsors page is open yet. Until it is, Upgrade offers only a code; set to true
 * in the release after the DragonsOath Sponsors page and its tiers are live.
 */
export const SPONSORS_OPEN = false;

/**
 * The one launch setting for the Founder price (Flint, 2026-11-13): the day the $60 launch price
 * ends, YYYY-MM-DD (launch + 7 months). Set it in the launch release; null before launch. The
 * Upgrade card and docs/SPONSORS.md both follow it (a test keeps them the same).
 */
export const FOUNDER_LAUNCH_ENDS: string | null = null;

/** "Founder: $60 launch price, $99 after <date>", then "Founder: $99" once the date has passed. */
export function founderPriceLine(now: Date = new Date(), ends = FOUNDER_LAUNCH_ENDS): string {
  if (!ends) return "Founder: $60 launch price, $99 after the first 7 months";
  if (now.toISOString().slice(0, 10) > ends) return "Founder: $99";
  const day = new Date(`${ends}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `Founder: $60 launch price, $99 after ${day}`;
}

/**
 * The promise to Founders (the owner and Flint, 2026-11-13), word for word on the Sponsors page
 * (docs/SPONSORS.md), the claim page, the manual's Premium section and the Hearth Pledge. Never
 * weaken it: it is a promise to people who already paid.
 */
export const FOUNDER_PROMISE: readonly { title: string; text: string }[] = [
  {
    title: "Premium for life",
    text: "Whatever a paying monthly Premium member gets, now or in the future, a Founder gets too, at no extra charge, even if Premium later becomes monthly billing only.",
  },
  {
    title: "The regular Founder price, $99, is never raised",
    text: "Founder may be retired at any time, with at least 30 days' public notice.",
  },
  {
    title: "Founders stay Founders",
    text: "Everyone who became a Founder before it closes keeps it, forever.",
  },
];

/** Features Hearth no longer has: a licence that names one still reads, and it is ignored. */
export const RETIRED_PREMIUM_FEATURES: readonly string[] = ["hearth_transfer", "curator_for_you"];

/** Where a grant came from. Paid and trial are ready for later; nothing sells or starts one yet. */
export type GrantKind = "complimentary" | "paid" | "trial";

/** What this installation has, feature by feature. */
export type EntitlementState =
  /** No grant for it. */
  | "free"
  | "active"
  /** Its end date has passed. */
  | "expired"
  /** The issuer took it back. */
  | "revoked"
  /** Not started yet. */
  | "scheduled"
  /** This computer's clock is behind the last time Hearth saw, so a dated grant can't be trusted. */
  | "pending";

export interface FeatureAccess {
  feature: PremiumFeature;
  state: EntitlementState;
  kind?: GrantKind;
  /** The licence that gives it (the best one when several do). */
  licenseId?: string;
  start?: string;
  /** Absent: it never ends. */
  end?: string;
}

export interface PremiumStatus {
  installId: string;
  /** Premium isn't switched on yet: every extra is open to every Hearth, as before Premium. */
  open?: boolean;
  features: FeatureAccess[];
  /** This Hearth can issue grants and codes (it holds the owner's signing key). */
  issuer: boolean;
  /** Redeeming a code needs the licence service; absent until it is switched on. */
  redeemOnline: boolean;
  licenses: {
    id: string;
    features: PremiumFeature[];
    kind: GrantKind;
    start: string;
    end?: string;
    state: EntitlementState;
    /** A short label the issuer chose for the recipient (never the owner's private notes). */
    label?: string;
  }[];
}

/** The scope's features, the bundle expanded. */
export const featuresOf = (scope: readonly PremiumGrantScope[]): PremiumFeature[] =>
  scope.includes(PREMIUM_BUNDLE)
    ? [...PREMIUM_FEATURES]
    : PREMIUM_FEATURES.filter((f) => scope.includes(f));
