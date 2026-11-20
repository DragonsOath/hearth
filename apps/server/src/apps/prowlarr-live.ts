import type { ProwlarrDashboard, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";

/**
 * Prowlarr's panel and controls: every indexer with whether it works, why not, and this week's
 * searches and grabs; which apps Prowlarr feeds; and testing one or all indexers, switching one on
 * or off, and pushing the indexer list to the apps. An indexer's settings (which can hold its
 * password) only travel back to Prowlarr itself, never into a result, a log, or the AI.
 */

type Method = "GET" | "POST" | "PUT";

async function call<T>(
  fetchImpl: Fetch,
  base: string,
  key: string,
  method: Method,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T }> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, path), {
      method,
      headers: {
        "X-Api-Key": key,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS * 4),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : "no answer";
    throw new AppUnreachableError(`Prowlarr did not answer at ${base}: ${why}`);
  }
  if (res.status === 401 || res.status === 403)
    throw new AppKeyError("Prowlarr refused the API key.");
  const data = (await res.json().catch(() => null)) as T;
  return { ok: res.ok, status: res.status, data };
}

async function get<T>(fetchImpl: Fetch, base: string, key: string, path: string): Promise<T> {
  const r = await call<T>(fetchImpl, base, key, "GET", path);
  if (!r.ok) throw new AppUnreachableError(`Prowlarr answered ${r.status} for ${path}.`);
  return r.data;
}

interface Indexer {
  id: number;
  name: string;
  enable?: boolean;
  protocol?: string;
  privacy?: string;
  priority?: number;
  tags?: number[];
  [k: string]: unknown;
}
interface Status {
  indexerId: number;
  disabledTill?: string;
  mostRecentFailure?: string;
}
interface Stats {
  indexers?: {
    indexerId: number;
    averageResponseTime?: number;
    numberOfQueries?: number;
    numberOfGrabs?: number;
    numberOfFailedQueries?: number;
    numberOfFailedGrabs?: number;
  }[];
}
interface Failure {
  errorMessage?: string;
}

/** Prowlarr's own words for why a test failed, short and without anything that looks like a key. */
const why = (failures: unknown) =>
  (Array.isArray(failures) ? (failures as Failure[]) : [])
    .map((f) => f.errorMessage ?? "")
    .filter(Boolean)
    .join(" ")
    .replace(/(apikey|passkey|key|token)=[^&\s]+/gi, "$1=[hidden]")
    .slice(0, 300) || "Prowlarr gave no reason.";

export async function prowlarrDashboard(
  fetchImpl: Fetch,
  base: string,
  key: string,
  now = new Date(),
): Promise<ProwlarrDashboard> {
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const [status, indexers, statuses, stats, apps, health, proxies] = await Promise.all([
    get<{ version?: string }>(fetchImpl, base, key, "/api/v1/system/status"),
    get<Indexer[]>(fetchImpl, base, key, "/api/v1/indexer"),
    get<Status[]>(fetchImpl, base, key, "/api/v1/indexerstatus"),
    get<Stats>(
      fetchImpl,
      base,
      key,
      `/api/v1/indexerstats?startDate=${encodeURIComponent(week)}`,
    ).catch(() => ({}) as Stats),
    get<{ name?: string; implementation?: string; syncLevel?: string }[]>(
      fetchImpl,
      base,
      key,
      "/api/v1/applications",
    ).catch(() => []),
    get<{ type?: string; message?: string; source?: string }[]>(
      fetchImpl,
      base,
      key,
      "/api/v1/health",
    ).catch(() => []),
    get<{ name: string; tags?: number[] }[]>(fetchImpl, base, key, "/api/v1/indexerProxy").catch(
      () => [],
    ),
  ]);
  const byId = new Map((stats.indexers ?? []).map((s) => [s.indexerId, s]));
  const rows = indexers
    .map((i) => {
      const st = statuses.find((s) => s.indexerId === i.id);
      const paused =
        st?.disabledTill && new Date(st.disabledTill) > now ? st.disabledTill : undefined;
      const s = byId.get(i.id);
      const via = proxies.filter((p) => (p.tags ?? []).some((t) => (i.tags ?? []).includes(t)));
      return {
        id: i.id,
        name: i.name,
        enabled: i.enable !== false,
        failing: i.enable !== false && Boolean(paused || st?.mostRecentFailure),
        ...(i.protocol ? { protocol: i.protocol } : {}),
        ...(i.privacy ? { privacy: i.privacy } : {}),
        ...(paused ? { pausedUntil: paused } : {}),
        ...(st?.mostRecentFailure ? { lastFailure: st.mostRecentFailure } : {}),
        queries: s?.numberOfQueries ?? 0,
        grabs: s?.numberOfGrabs ?? 0,
        failedQueries: s?.numberOfFailedQueries ?? 0,
        failedGrabs: s?.numberOfFailedGrabs ?? 0,
        ...(s?.averageResponseTime ? { avgMs: Math.round(s.averageResponseTime) } : {}),
        ...(via.length ? { proxies: via.map((p) => p.name) } : {}),
      };
    })
    // Failing first, then switched off last, so what needs attention is on top.
    .sort(
      (a, b) =>
        Number(b.failing) - Number(a.failing) ||
        Number(b.enabled) - Number(a.enabled) ||
        a.name.localeCompare(b.name),
    );
  return {
    app: "prowlarr",
    ...(status.version ? { version: status.version } : {}),
    totals: {
      indexers: rows.length,
      enabled: rows.filter((r) => r.enabled).length,
      failing: rows.filter((r) => r.failing).length,
      queries: rows.reduce((n, r) => n + r.queries, 0),
      grabs: rows.reduce((n, r) => n + r.grabs, 0),
    },
    indexers: rows,
    apps: apps.map((a) => ({
      name: a.name ?? a.implementation ?? "An app",
      ...(a.implementation ? { kind: a.implementation } : {}),
      sync: a.syncLevel === "fullSync" ? "full" : a.syncLevel === "addOnly" ? "add only" : "off",
    })),
    health: health
      .filter((h) => h.type === "warning" || h.type === "error")
      .map((h) => ({
        level: h.type === "error" ? ("error" as const) : ("warning" as const),
        text: h.message ?? "Prowlarr reports a problem.",
      })),
  };
}

export const PROWLARR_OPS = ["test", "test-all", "enable", "disable", "sync-apps"] as const;
type Op = (typeof PROWLARR_OPS)[number];

export class ProwlarrOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  private use<T>(
    service: { id: string; localUrl: string },
    purpose: string,
    access: "read" | "change",
    fn: (key: string) => Promise<T>,
  ) {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value }) => fn(value),
    );
  }

  private read(service: { id: string; localUrl: string }) {
    return this.use(service, "read Prowlarr's indexers", "read", (key) =>
      prowlarrDashboard(this.fetchImpl, service.localUrl, key),
    );
  }

  async plan(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as Op;
    if (!PROWLARR_OPS.includes(op)) throw new Error(`Say what to do: ${PROWLARR_OPS.join(", ")}.`);
    const d = await this.read(service);
    const id = Number(params?.indexerId);
    const ix = d.indexers.find((i) => i.id === id);
    let label: string;
    if (op === "test-all") label = `Test all ${d.totals.enabled} indexers in ${service.name}`;
    else if (op === "sync-apps") {
      if (!d.apps.length) throw new Error(`${service.name} is not connected to any apps yet.`);
      label = `Send ${service.name}'s indexers to ${d.apps.map((a) => a.name).join(", ")}`;
    } else {
      if (!ix) throw new Error("That indexer is not in Prowlarr any more.");
      if (op === "enable" && ix.enabled) throw new Error(`${ix.name} is already on.`);
      if (op === "disable" && !ix.enabled) throw new Error(`${ix.name} is already off.`);
      label =
        op === "test"
          ? `Test ${ix.name} in ${service.name}`
          : op === "enable"
            ? `Turn ${ix.name} on in ${service.name}`
            : `Turn ${ix.name} off in ${service.name} (Radarr and Sonarr stop searching it after the next sync)`;
    }
    return {
      ...base,
      label,
      serviceName: service.name,
      params: { op, ...(ix ? { indexerId: ix.id, name: ix.name } : {}) },
      change: {
        summary: label,
        settings: [
          {
            name: ix?.name ?? "Indexers",
            before: ix
              ? ix.enabled
                ? ix.failing
                  ? "on, failing"
                  : "on"
                : "off"
              : `${d.totals.failing} failing`,
            after: op,
          },
        ],
      },
    };
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    const id = Number(p.indexerId);
    const name = String(p.name || "the indexers");
    const outcome = await this.use(service, `${op} in Prowlarr`, "change", async (key) => {
      const base = service.localUrl;
      if (op === "test-all") {
        const r = await call<{ id: number; isValid?: boolean; validationFailures?: unknown }[]>(
          this.fetchImpl,
          base,
          key,
          "POST",
          "/api/v1/indexer/testall",
        );
        const results = Array.isArray(r.data) ? r.data : [];
        const d = await prowlarrDashboard(this.fetchImpl, base, key);
        const names = new Map(d.indexers.map((i) => [i.id, i.name]));
        const bad = results.filter((x) => x.isValid === false);
        return {
          ok: true,
          result: bad.length
            ? `${results.length - bad.length} of ${results.length} indexers work. Failing: ${bad
                .map(
                  (b) => `${names.get(b.id) ?? `indexer ${b.id}`} (${why(b.validationFailures)})`,
                )
                .join("; ")}`
            : `All ${results.length} indexers work.`,
        };
      }
      if (op === "sync-apps") {
        const r = await call<{ id?: number }>(
          this.fetchImpl,
          base,
          key,
          "POST",
          "/api/v1/command",
          {
            name: "ApplicationIndexerSync",
          },
        );
        if (!r.ok || !r.data?.id)
          return { ok: false, result: `Prowlarr did not take the sync (${r.status}).` };
        for (let i = 0; i < 10; i++) {
          const c = await get<{ status?: string; message?: string }>(
            this.fetchImpl,
            base,
            key,
            `/api/v1/command/${r.data.id}`,
          );
          if (c.status === "completed")
            return { ok: true, result: "Prowlarr sent its indexers to your apps." };
          if (c.status === "failed")
            return { ok: false, result: `The sync failed: ${c.message ?? "no reason given"}.` };
          await this.wait(1500);
        }
        return {
          ok: true,
          result: "Prowlarr started sending its indexers to your apps; it is still going.",
        };
      }
      // One indexer: its full settings go back to Prowlarr unchanged except for what this step does.
      const ix = await get<Indexer>(this.fetchImpl, base, key, `/api/v1/indexer/${id}`);
      if (op === "test") {
        const r = await call<unknown>(
          this.fetchImpl,
          base,
          key,
          "POST",
          "/api/v1/indexer/test",
          ix,
        );
        return r.ok
          ? { ok: true, result: `${name} works: Prowlarr reached it and searched.` }
          : { ok: false, result: `${name} failed its test: ${why(r.data)}` };
      }
      const r = await call<Indexer>(this.fetchImpl, base, key, "PUT", `/api/v1/indexer/${id}`, {
        ...ix,
        enable: op === "enable",
      });
      if (!r.ok)
        return { ok: false, result: `Prowlarr did not save it (${r.status}): ${why(r.data)}` };
      const back = await get<Indexer>(this.fetchImpl, base, key, `/api/v1/indexer/${id}`);
      return back.enable === (op === "enable")
        ? {
            ok: true,
            result: `${name} is ${op === "enable" ? "on" : "off"}. Prowlarr confirms it.`,
          }
        : {
            ok: false,
            result: `Prowlarr answered, but ${name} still shows ${back.enable ? "on" : "off"}.`,
          };
    });
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${op} (${name}) in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, ok: outcome.ok },
    });
    return outcome;
  }
}
