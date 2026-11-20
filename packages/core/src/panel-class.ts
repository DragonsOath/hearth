import type { Service } from "./domain";
import { appKindOf } from "./apps";
import { coverageOf } from "./coverage";

/**
 * Which kind of panel a service gets (Ember Panel Builder, Phase 1, 11-10). One rule, used by the
 * web app to pick the Overview and by the server to decide what Panel Builder may touch:
 *
 * - first-party: a panel Hearth ships (a hand-built dashboard, or an app in the panel registry).
 * - watch-only: infrastructure Hearth only watches (a database, a cache, the VPN, the proxy) or a
 *   plain process. Health, logs and resources are the useful view; nothing to build on.
 * - basic: an app Hearth has no panel for. Only these offer "Improve this panel".
 *
 * Hearth's own tools (Home Rows, Storage, Forge, Curator...) are not services at all, so they never
 * reach this rule and Panel Builder can never target them.
 */
export type PanelClass = "first-party" | "watch-only" | "basic";

/** Hearth's hand-built dashboards for apps outside the panel registry. */
export type HandBuiltDashboard = "gluetun" | "caddy" | "flaresolverr" | "tinyauth" | "recyclarr";

type ServiceLike = Pick<Service, "name" | "image" | "container" | "kind">;

export function handBuiltDashboardOf(service: ServiceLike): HandBuiltDashboard | undefined {
  const id = `${service.image ?? ""} ${service.container ?? ""} ${service.name}`;
  if (/gluetun/i.test(id)) return "gluetun";
  if (
    /(^|\/)caddy(:|$)/i.test(service.image ?? "") ||
    /^caddy$/i.test(service.container ?? "") ||
    /^caddy$/i.test(service.name)
  )
    return "caddy";
  if (/flaresolverr/i.test(id)) return "flaresolverr";
  if (/tinyauth/i.test(id)) return "tinyauth";
  if (/recyclarr/i.test(id)) return "recyclarr";
  return undefined;
}

export function panelClassOf(service: ServiceLike): PanelClass {
  if (handBuiltDashboardOf(service) || appKindOf(service)) return "first-party";
  if (service.kind === "process") return "watch-only";
  const kind = coverageOf(service).kind;
  if (kind === "infrastructure" || kind === "protected") return "watch-only";
  return "basic";
}

/**
 * Network and security apps keep Hearth's own panel (11-19, the owner approved): a custom panel
 * that broke there could hide a real problem with the VPN, the proxy, DNS, sign-in or passwords.
 */
const LOCKED_APPS = new Set<string>([
  "tailscale",
  "wgeasy",
  "traefik",
  "npm",
  "adguard",
  "pihole",
  "authentik",
  "authelia",
  "vaultwarden",
]);
const LOCKED_DASHBOARDS = new Set<HandBuiltDashboard>(["gluetun", "caddy", "tinyauth"]);

/**
 * Whether Panel Builder may work on this service's panel. Basic panels (Phase 1), and since 11-19
 * Hearth's own app panels too (the owner: "if someone wants to change what gets displayed to them
 * they should"): there the custom panel is a layer, Hearth's panel one click away. Never network
 * or security apps, infrastructure Hearth only watches, or Hearth's own tools (not services).
 */
export function canImprovePanel(service: ServiceLike): boolean {
  const cls = panelClassOf(service);
  if (cls === "basic") return true;
  if (cls !== "first-party") return false;
  const dash = handBuiltDashboardOf(service);
  if (dash) return !LOCKED_DASHBOARDS.has(dash);
  const kind = appKindOf(service);
  return Boolean(kind && !LOCKED_APPS.has(kind));
}
