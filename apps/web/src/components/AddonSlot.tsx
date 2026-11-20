import { createElement, type ReactNode } from "react";
import { Link } from "react-router";
import { PREMIUM_INFO, type PremiumFeature } from "@dragon-control/core";
import { useSlot } from "../lib/addons";

/**
 * A place an add-on can fill (lib/addons.ts). Without one, the core's fallback shows: for a
 * Premium feature, its Premium card. The core never needs the add-on to work.
 */
export function AddonSlot({
  name,
  fallback,
  props = {},
}: {
  name: string;
  fallback: ReactNode;
  props?: Record<string, unknown>;
}) {
  const Filled = useSlot(name);
  // createElement: the component comes from the add-on's registry, not from this render.
  return Filled ? createElement(Filled, props) : <>{fallback}</>;
}

/** What a Premium feature is and what stays free, with the way to get it. */
export function PremiumCard({ feature }: { feature: PremiumFeature }) {
  const info = PREMIUM_INFO[feature];
  return (
    <div
      className="space-y-2 rounded-xl border border-line bg-panel/60 p-4"
      data-testid={`premium-card-${feature}`}
    >
      <p className="text-[0.95rem] font-semibold text-ink">{info.name} is part of Hearth Premium</p>
      <p className="text-[0.85rem] text-muted">{info.what}</p>
      <p className="text-[0.85rem] text-muted">{info.free}</p>
      <Link to="/settings#premium" className="text-[0.85rem] text-gold underline">
        Upgrade: sponsor or enter a code
      </Link>
    </div>
  );
}
