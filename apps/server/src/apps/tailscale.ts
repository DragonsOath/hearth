import type {
  AppIssue,
  AppReport,
  TailscaleDashboard,
  TailscaleDevice,
} from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Tailscale, through its own cloud API (api.tailscale.com, v2) with an API access token from the
 * vault, for the tailnet the token belongs to ("-"). Tailscale keeps the device list in its own
 * service, not on your server, so this is the one reader whose address is fixed: the vault entry
 * names https://api.tailscale.com and the broker sends the token nowhere else.
 *
 * The calls, fields and request bodies follow Tailscale's official API client
 * (tailscale/tailscale-client-go-v2 at f9e92a8), which sends the token as Basic auth. This reader
 * has been tested against a stand-in only, not a real tailnet. Hearth never passes on a device's
 * machine, node or tailnet lock keys, its posture data or serial numbers.
 */

export const TAILSCALE_API = "https://api.tailscale.com";
const TAILNET = "-";

export class TailscaleError extends Error {}

export async function ts<T>(
  fetchImpl: Fetch,
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(TAILSCALE_API, `/api/v2${path}`), {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `Tailscale's API did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (res.status === 401)
    throw new AppKeyError(
      "Tailscale refused the access token: it may have expired (they last up to 90 days). Make a new one in Tailscale's admin console, Settings, Keys.",
    );
  if (res.status === 403)
    throw new AppKeyError(
      "Tailscale says this token may not do that. Use an admin's access token.",
    );
  if (!res.ok) {
    const text = (await res.text?.().catch(() => "")) ?? "";
    const said = /"message"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1];
    throw new TailscaleError(
      `Tailscale refused ${method} ${path.split("?")[0]}: ${redactLine(said ?? `answer ${res.status}`)}.`,
    );
  }
  const text = (await res.text?.()) ?? "";
  return (text ? JSON.parse(text) : undefined) as T;
}

const EXIT = ["0.0.0.0/0", "::/0"];

export interface RawDevice {
  id?: string;
  nodeId?: string;
  name?: string;
  hostname?: string;
  os?: string;
  user?: string;
  tags?: string[];
  addresses?: string[];
  connectedToControl?: boolean;
  lastSeen?: string | null;
  authorized?: boolean;
  expires?: string;
  keyExpiryDisabled?: boolean;
  clientVersion?: string;
  updateAvailable?: boolean;
  advertisedRoutes?: string[];
  // Tailscale's own Go client spells this one with a capital letter.
  AdvertisedRoutes?: string[];
  enabledRoutes?: string[];
  isExternal?: boolean;
  isEphemeral?: boolean;
  sshEnabled?: boolean;
}

/** Tailscale writes 0001-01-01 for a time it does not have. */
const when = (t?: string | null) => (t && !t.startsWith("0001-") ? t : undefined);

/** Only these fields: a device also carries its machine, node and tailnet lock keys. */
export function toDevice(d: RawDevice): TailscaleDevice {
  const fqdn = d.name ?? d.hostname ?? "";
  const offered = d.advertisedRoutes ?? d.AdvertisedRoutes ?? [];
  const approved = d.enabledRoutes ?? [];
  const lastSeen = when(d.lastSeen);
  const expires = when(d.expires);
  return {
    id: d.nodeId ?? d.id ?? "",
    name: fqdn.split(".")[0] || (d.hostname ?? ""),
    fqdn,
    hostname: d.hostname ?? "",
    os: d.os ?? "",
    user: d.user ?? "",
    tags: d.tags ?? [],
    addresses: [...(d.addresses ?? [])].sort(
      (a, b) => Number(a.includes(":")) - Number(b.includes(":")),
    ),
    online: d.connectedToControl === true,
    ...(lastSeen ? { lastSeen } : {}),
    authorized: d.authorized !== false,
    ...(!d.keyExpiryDisabled && expires ? { keyExpires: expires } : {}),
    keyExpiryDisabled: d.keyExpiryDisabled === true,
    ...(d.clientVersion ? { clientVersion: d.clientVersion.split("-")[0]! } : {}),
    updateAvailable: d.updateAvailable === true,
    exitNode: {
      offered: EXIT.some((r) => offered.includes(r)),
      approved: EXIT.some((r) => approved.includes(r)),
    },
    routes: {
      offered: offered.filter((r) => !EXIT.includes(r)),
      approved: approved.filter((r) => !EXIT.includes(r)),
    },
    external: d.isExternal === true,
    ephemeral: d.isEphemeral === true,
    ssh: d.sshEnabled === true,
  };
}

export const listDevices = (fetchImpl: Fetch, key: string) =>
  ts<{ devices?: RawDevice[] }>(
    fetchImpl,
    key,
    "GET",
    `/tailnet/${TAILNET}/devices?fields=all`,
  ).then((r) =>
    (r?.devices ?? [])
      .map(toDevice)
      .sort((a, b) => Number(a.authorized) - Number(b.authorized) || a.name.localeCompare(b.name)),
  );

export async function tailscaleDashboard(
  fetchImpl: Fetch,
  key: string,
): Promise<TailscaleDashboard> {
  const [devices, prefs, ns] = await Promise.all([
    listDevices(fetchImpl, key),
    ts<{ magicDNS?: boolean }>(fetchImpl, key, "GET", `/tailnet/${TAILNET}/dns/preferences`).catch(
      () => undefined,
    ),
    ts<{ dns?: string[] }>(fetchImpl, key, "GET", `/tailnet/${TAILNET}/dns/nameservers`).catch(
      () => undefined,
    ),
  ]);
  const domain = devices
    .map((d) => d.fqdn.split(".").slice(1).join("."))
    .find((x) => /\.ts\.net$|\./.test(x));
  return {
    app: "tailscale",
    ...(domain ? { domain } : {}),
    devices,
    dns: {
      ...(typeof prefs?.magicDNS === "boolean" ? { magicDns: prefs.magicDNS } : {}),
      nameservers: ns?.dns ?? [],
    },
  };
}

const DAY = 86_400_000;
const KEY_WARN_DAYS = 14;

export const daysLeft = (iso: string, now = Date.now()) =>
  Math.floor((Date.parse(iso) - now) / DAY);

export async function readTailscale(
  key: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await tailscaleDashboard(fetchImpl, key);
  const issues: AppIssue[] = [];
  const own = d.devices.filter((x) => !x.external);
  const waiting = own.filter((x) => !x.authorized);
  if (waiting.length)
    issues.push({
      level: "warning",
      key: "waiting",
      text: `${waiting.map((x) => x.name).join(", ")} ${waiting.length === 1 ? "is" : "are"} waiting for approval to join your tailnet.`,
    });
  const expired = own.filter((x) => x.keyExpires && daysLeft(x.keyExpires) < 0);
  if (expired.length)
    issues.push({
      level: "error",
      key: "keys-expired",
      text: `The key for ${expired.map((x) => x.name).join(", ")} has expired: ${expired.length === 1 ? "it is" : "they are"} off the tailnet until signed in again.`,
    });
  const soon = own.filter(
    (x) => x.keyExpires && daysLeft(x.keyExpires) >= 0 && daysLeft(x.keyExpires) < KEY_WARN_DAYS,
  );
  if (soon.length)
    issues.push({
      level: "warning",
      key: "keys-expiring",
      text: `The key for ${soon.map((x) => `${x.name} (${daysLeft(x.keyExpires!)} days)`).join(", ")} runs out soon.`,
    });
  const exits = own.filter((x) => x.exitNode.offered && !x.exitNode.approved);
  return {
    app: "tailscale",
    status: worst(issues),
    issues,
    facts: [
      { label: "Devices online", value: `${own.filter((x) => x.online).length} of ${own.length}` },
      ...(exits.length ? [{ label: "Exit nodes to approve", value: String(exits.length) }] : []),
      ...(own.some((x) => x.updateAvailable)
        ? [{ label: "Updates", value: String(own.filter((x) => x.updateAvailable).length) }]
        : []),
    ],
  };
}
