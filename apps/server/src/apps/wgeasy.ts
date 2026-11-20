import type { AppIssue, AppReport, WgEasyDashboard, WgPeer } from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * wg-easy (version 15), through its API with the web page's username and password from the vault,
 * sent as Basic auth, which its API takes. Checked against a throwaway ghcr.io/wg-easy/wg-easy:15.
 *
 * A client's configuration file, QR code and one-time link carry its private key: Hearth never
 * asks for them. The interface's settings and hooks are not read either (keys and shell commands);
 * only the address clients connect to, the subnet, DNS and allowed addresses.
 */

export class WgEasyError extends Error {}

export interface WgLogin {
  username: string;
  password: string;
}

export async function wg<T>(
  fetchImpl: Fetch,
  base: string,
  login: WgLogin,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, path), {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${login.username}:${login.password}`).toString("base64")}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `wg-easy did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (res.status === 401)
    throw new AppKeyError(
      "wg-easy refused the username or password. Check the login in the vault (two-factor sign-in on that account also stops Hearth).",
    );
  if (res.status === 404 && path === "/api/client")
    throw new AppKeyError("This wg-easy has no version 15 API: Hearth reads wg-easy 15 or later.");
  if (!res.ok) {
    const text = (await res.text?.().catch(() => "")) ?? "";
    const said = /"message"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1];
    throw new WgEasyError(
      `wg-easy refused ${method} ${path}: ${redactLine(said ?? `answer ${res.status}`)}.`,
    );
  }
  const text = (await res.text?.()) ?? "";
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface RawClient {
  id: number;
  name: string;
  enabled?: boolean;
  ipv4Address?: string;
  ipv6Address?: string;
  latestHandshakeAt?: string | null;
  endpoint?: string | null;
  transferRx?: number;
  transferTx?: number;
  expiresAt?: string | null;
  createdAt?: string;
}

/** WireGuard re-handshakes every two minutes while traffic flows. */
const CONNECTED_MS = 3 * 60_000;

/** Only these fields: never a key, the configuration or the one-time link. */
export function toPeer(c: RawClient, now = Date.now()): WgPeer {
  const hs = c.latestHandshakeAt ?? undefined;
  return {
    id: c.id,
    name: c.name,
    enabled: c.enabled !== false,
    address: c.ipv4Address ?? c.ipv6Address ?? "",
    ...(hs ? { lastHandshake: hs } : {}),
    connected: Boolean(hs && now - Date.parse(hs) < CONNECTED_MS),
    ...(c.endpoint ? { from: c.endpoint } : {}),
    // wg-easy reports transfer from the server's side: what it received came from the client.
    receivedBytes: c.transferRx ?? 0,
    sentBytes: c.transferTx ?? 0,
    ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}),
    ...(c.createdAt ? { created: c.createdAt } : {}),
  };
}

export const listPeers = (fetchImpl: Fetch, base: string, login: WgLogin) =>
  wg<RawClient[]>(fetchImpl, base, login, "GET", "/api/client").then((list) =>
    (list ?? []).map((c) => toPeer(c)).sort((a, b) => a.name.localeCompare(b.name)),
  );

export async function wgEasyDashboard(
  fetchImpl: Fetch,
  base: string,
  login: WgLogin,
): Promise<WgEasyDashboard> {
  const [peers, user, iface, info] = await Promise.all([
    listPeers(fetchImpl, base, login),
    wg<{ host?: string; port?: number; defaultDns?: string[]; defaultAllowedIps?: string[] }>(
      fetchImpl,
      base,
      login,
      "GET",
      "/api/admin/userconfig",
    ).catch(() => undefined),
    wg<{ ipv4Cidr?: string }>(fetchImpl, base, login, "GET", "/api/admin/interface").catch(
      () => undefined,
    ),
    // It asks GitHub for the latest release, so it fails without internet.
    wg<{
      currentRelease?: string;
      latestRelease?: { version?: string };
      updateAvailable?: boolean;
    }>(fetchImpl, base, login, "GET", "/api/information").catch(() => undefined),
  ]);
  return {
    app: "wgeasy",
    ...(info?.currentRelease ? { version: info.currentRelease } : {}),
    ...(info?.updateAvailable && info.latestRelease?.version
      ? { latest: info.latestRelease.version }
      : {}),
    ...(user?.host ? { host: user.host } : {}),
    ...(user?.port ? { port: user.port } : {}),
    ...(iface?.ipv4Cidr ? { subnet: iface.ipv4Cidr } : {}),
    dns: user?.defaultDns ?? [],
    allowedIps: user?.defaultAllowedIps ?? [],
    peers,
  };
}

export async function readWgEasy(
  base: string,
  login: WgLogin,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await wgEasyDashboard(fetchImpl, base, login);
  const issues: AppIssue[] = [];
  const now = Date.now();
  const expired = d.peers.filter((p) => p.enabled && p.expiresAt && Date.parse(p.expiresAt) < now);
  if (expired.length)
    issues.push({
      level: "warning",
      key: "expired",
      text: `${expired.map((p) => p.name).join(", ")} ${expired.length === 1 ? "has" : "have"} passed ${expired.length === 1 ? "its" : "their"} end date but ${expired.length === 1 ? "is" : "are"} still on.`,
    });
  if (d.latest)
    issues.push({ level: "warning", key: "update", text: `wg-easy ${d.latest} is out.` });
  return {
    app: "wgeasy",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      {
        label: "Connected now",
        value: `${d.peers.filter((p) => p.connected).length} of ${d.peers.filter((p) => p.enabled).length}`,
      },
      ...(d.peers.some((p) => !p.enabled)
        ? [{ label: "Turned off", value: String(d.peers.filter((p) => !p.enabled).length) }]
        : []),
    ],
  };
}
