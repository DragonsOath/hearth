import type { AppReport, KavitaDashboard, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Kavita, with an administrator's API key pasted once: Kavita trades the key for a short-lived
 * token (POST /api/Plugin/authenticate), then every read uses that token. The health read, the
 * panel (series, files and size, libraries and when each was last scanned, scheduled jobs, files
 * Kavita could not read), and the controls: scan one library or all, and back up its database.
 * Routes checked against Kavita's own source (Kavita.Server/Controllers).
 */

type Method = "GET" | "POST";

async function request<T>(
  fetchImpl: Fetch,
  base: string,
  method: Method,
  path: string,
  token?: string,
): Promise<{ ok: boolean; status: number; data: T }> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, path), {
      method,
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : "no answer";
    throw new AppUnreachableError(
      `Kavita did not answer at ${base}: ${why.replace(/apiKey=[^&\s]+/g, "apiKey=[hidden]")}`,
    );
  }
  const data = (await res.json().catch(() => null)) as T;
  return { ok: res.ok, status: res.status, data };
}

/** A session: the key is traded for a token once, and every call after uses the token. */
export async function session(fetchImpl: Fetch, base: string, key: string) {
  const r = await request<{ token?: string }>(
    fetchImpl,
    base,
    "POST",
    `/api/Plugin/authenticate?apiKey=${encodeURIComponent(key)}&pluginName=Hearth`,
  );
  if (!r.ok || !r.data?.token)
    throw new AppKeyError(
      "Kavita refused the API key. Copy it again from Kavita and paste it in its panel.",
    );
  const token = r.data.token;
  const call = <T>(method: Method, path: string) =>
    request<T>(fetchImpl, base, method, path, token);
  const get = async <T>(path: string): Promise<T> => {
    const x = await call<T>("GET", path);
    if (x.status === 401 || x.status === 403)
      throw new AppKeyError(
        "Kavita's key belongs to a user who is not an administrator. Use an administrator's key.",
      );
    if (!x.ok)
      throw new AppUnreachableError(`Kavita answered ${x.status} for ${path.split("?")[0]}.`);
    return x.data;
  };
  return { call, get };
}

const LIBRARY_TYPES = ["manga", "comics", "books", "images", "light novels", "comics"];

export async function kavitaDashboard(
  fetchImpl: Fetch,
  base: string,
  key: string,
): Promise<KavitaDashboard> {
  const { get } = await session(fetchImpl, base, key);
  const [info, stats, libraries, jobs, errors] = await Promise.all([
    get<{ kavitaVersion?: string }>("/api/Server/server-info-slim").catch(
      () => ({}) as { kavitaVersion?: string },
    ),
    get<{
      seriesCount?: number;
      volumeCount?: number;
      chapterCount?: number;
      totalFiles?: number;
      totalSize?: number;
      totalReadingTime?: number;
    }>("/api/Stats/server/stats"),
    get<{ id: number; name?: string; type?: number; lastScanned?: string; folders?: string[] }[]>(
      "/api/Library/libraries",
    ),
    get<{ id: string; title?: string; lastExecutionUtc?: string | null; cron?: string }[]>(
      "/api/Server/jobs",
    ).catch(() => []),
    get<
      {
        filePath?: string;
        details?: string;
        seriesName?: string | null;
        libraryName?: string | null;
        isDismissed?: boolean;
        lastSeenUtc?: string;
      }[]
    >("/api/Server/media-errors").catch(() => []),
  ]);
  const open = errors.filter((e) => !e.isDismissed);
  const real = (t?: string | null) =>
    t && !t.startsWith("0001") ? `${t.replace(/Z?$/, "Z")}` : undefined;
  return {
    app: "kavita",
    ...(info.kavitaVersion ? { version: info.kavitaVersion } : {}),
    series: stats.seriesCount ?? 0,
    volumes: stats.volumeCount ?? 0,
    chapters: stats.chapterCount ?? 0,
    files: stats.totalFiles ?? 0,
    sizeGb: Math.round(((stats.totalSize ?? 0) / 1024 ** 3) * 10) / 10,
    readingHours: Math.round(stats.totalReadingTime ?? 0),
    libraries: libraries.map((l) => ({
      id: l.id,
      name: l.name ?? "A library",
      kind: LIBRARY_TYPES[l.type ?? 2] ?? "books",
      folders: (l.folders ?? []).length,
      ...(real(l.lastScanned) ? { lastScanned: real(l.lastScanned)! } : {}),
    })),
    jobs: jobs.map((j) => ({
      name: j.title ?? j.id,
      ...(real(j.lastExecutionUtc) ? { lastRan: real(j.lastExecutionUtc)! } : {}),
    })),
    unreadable: {
      count: open.length,
      files: open.slice(0, 6).map((e) => ({
        file: (e.filePath ?? "").split(/[\\/]/).pop() ?? "a file",
        where: [e.libraryName, e.seriesName].filter(Boolean).join(" · "),
        why: (e.details ?? "").slice(0, 200),
      })),
    },
  };
}

/** The background health read. */
export async function readKavita(
  base: string,
  key: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await kavitaDashboard(fetchImpl, base, key);
  const issues = d.unreadable.count
    ? [
        {
          level: "warning" as const,
          key: "media-errors",
          text: `Kavita could not read ${d.unreadable.count} files.`,
        },
      ]
    : [];
  return {
    app: "kavita",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Series", value: String(d.series) },
      { label: "Libraries", value: String(d.libraries.length) },
      { label: "Files", value: `${d.files} (${d.sizeGb} GB)` },
    ],
  };
}

export const KAVITA_OPS = ["scan-library", "scan-all", "backup-db"] as const;
type Op = (typeof KAVITA_OPS)[number];

export class KavitaOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
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

  async plan(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as Op;
    if (!KAVITA_OPS.includes(op)) throw new Error(`Say what to do: ${KAVITA_OPS.join(", ")}.`);
    const d = await this.use(service, "read Kavita", "read", (k) =>
      kavitaDashboard(this.fetchImpl, service.localUrl, k),
    );
    let label: string;
    let extra: Record<string, string | number> = {};
    if (op === "scan-all")
      label = `Scan all ${d.libraries.length} libraries in ${service.name} for new and changed files`;
    else if (op === "backup-db") label = `Back up ${service.name}'s database now`;
    else {
      const l = d.libraries.find((x) => x.id === Number(params?.libraryId));
      if (!l) throw new Error("Kavita does not have that library.");
      label = `Scan the ${l.name} library in ${service.name}`;
      extra = { libraryId: l.id, name: l.name };
    }
    return {
      ...base,
      label,
      serviceName: service.name,
      params: { op, ...extra },
      change: {
        summary: label,
        settings: [{ name: String(extra.name ?? "Kavita"), before: "as it is", after: op }],
      },
    };
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    const name = String(p.name || "the libraries");
    const outcome = await this.use(
      service,
      `${op} in Kavita`,
      "change",
      async (key): Promise<StepOutcome> => {
        const { call } = await session(this.fetchImpl, service.localUrl, key);
        const path =
          op === "scan-all"
            ? "/api/Library/scan-all?force=false"
            : op === "backup-db"
              ? "/api/Server/backup-db"
              : `/api/Library/scan?libraryId=${Number(p.libraryId)}&force=false`;
        const r = await call<unknown>("POST", path);
        if (!r.ok) return { ok: false, result: `Kavita refused it (${r.status}).` };
        return {
          ok: true,
          result:
            op === "backup-db"
              ? "Kavita is backing up its database."
              : `Kavita is scanning ${name}; new files show up as it finds them.`,
        };
      },
    );
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${op} (${name}) in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, ok: outcome.ok },
    });
    return outcome;
  }
}
