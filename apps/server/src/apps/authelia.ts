import type { AppIssue, AppReport, AutheliaDashboard } from "@dragon-control/core";
import { AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Authelia, a light read-only panel. Checked against a throwaway ghcr.io/authelia/authelia 4.39.28.
 *
 * Authelia has no admin API (its users and rules are files), and needs no key for what Hearth reads:
 * its health check (/api/health) and, when its metrics are on (telemetry, port 9959 by default),
 * its Prometheus metrics. Those count sign-ins without names, so nothing personal or secret is read.
 */

/** Authelia's own metrics port; the address can name another (metricsUrl). */
export const METRICS_PORT = 9959;

export function metricsUrl(base: string): string {
  const u = new URL(base);
  u.port = String(METRICS_PORT);
  u.pathname = "/metrics";
  u.search = "";
  return u.toString();
}

/** Sum the samples of one metric whose labels match. */
export function metric(
  text: string,
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  let found = false;
  let sum = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith(name)) continue;
    const m = /^([a-zA-Z_:][\w:]*)(\{([^}]*)\})?\s+([^\s]+)/.exec(line);
    if (!m || m[1] !== name) continue;
    const have = Object.fromEntries(
      [...(m[3] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]),
    );
    if (Object.entries(labels).some(([k, v]) => have[k] !== v)) continue;
    const v = Number(m[4]);
    if (Number.isFinite(v)) {
      found = true;
      sum += v;
    }
  }
  return found ? sum : undefined;
}

export async function autheliaDashboard(
  fetchImpl: Fetch,
  base: string,
): Promise<AutheliaDashboard> {
  const get = (url: string) =>
    fetchImpl(url, {
      method: "GET",
      headers: { Accept: "*/*" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  let health: Awaited<ReturnType<Fetch>>;
  try {
    health = await get(joinUrl(base, "/api/health"));
  } catch (error) {
    throw new AppUnreachableError(
      `Authelia did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const status = ((await health.json().catch(() => ({}))) as { status?: string }).status;
  const address = metricsUrl(base);
  const text = await get(address)
    .then(async (r) => (r.ok ? ((await r.text?.()) ?? "") : ""))
    .catch(() => "");
  const healthy = health.ok && status === "OK";
  if (!text.includes("authelia_"))
    return { app: "authelia", healthy, metrics: false, metricsAddress: address };
  const start = metric(text, "process_start_time_seconds");
  const rss = metric(text, "process_resident_memory_bytes");
  const okSum = metric(text, "authelia_authn_duration_sum", { success: "true" });
  const okCount = metric(text, "authelia_authn_duration_count", { success: "true" });
  // Any request Authelia answered with a 5xx code.
  const errors = [
    ...text.matchAll(/^authelia_request\{[^}]*code="5\d\d"[^}]*\}\s+([\d.e+]+)/gm),
  ].reduce((n, m) => n + Number(m[1]), 0);
  return {
    app: "authelia",
    healthy,
    metrics: true,
    metricsAddress: address,
    ...(start ? { since: new Date(start * 1000).toISOString() } : {}),
    ...(rss ? { memoryMb: Math.round(rss / 1_048_576) } : {}),
    signIns: metric(text, "authelia_authn", { success: "true" }) ?? 0,
    failed: metric(text, "authelia_authn", { success: "false", banned: "false" }) ?? 0,
    banned: metric(text, "authelia_authn", { banned: "true" }) ?? 0,
    ...(okSum !== undefined && okCount ? { signInMs: Math.round((okSum / okCount) * 1000) } : {}),
    serverErrors: errors,
  };
}

export async function readAuthelia(
  base: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await autheliaDashboard(fetchImpl, base);
  const issues: AppIssue[] = [];
  if (!d.healthy)
    issues.push({
      level: "error",
      key: "unhealthy",
      text: "Authelia says it is not healthy: nobody can sign in to the apps behind it.",
    });
  if (d.banned)
    issues.push({
      level: "warning",
      key: "banned",
      text: `Authelia refused ${d.banned} sign-ins from people it banned for too many wrong tries.`,
    });
  if (d.serverErrors)
    issues.push({
      level: "warning",
      key: "server-errors",
      text: `Authelia answered ${d.serverErrors} requests with a server error.`,
    });
  return {
    app: "authelia",
    status: worst(issues),
    issues,
    facts: d.metrics
      ? [
          { label: "Sign-ins", value: String(d.signIns ?? 0) },
          { label: "Failed", value: String(d.failed ?? 0) },
        ]
      : [{ label: "Metrics", value: "off" }],
  };
}
