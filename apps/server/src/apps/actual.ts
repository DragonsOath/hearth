import { createHash } from "node:crypto";
import type { AppIssue, AppReport, ActualDashboard } from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Actual Budget's sync server, a light panel, read with the server password from the vault. It
 * signs in once (POST /account/login) and keeps the session in memory, signing in again when the
 * server forgets it. Checked against a throwaway actualbudget/actual-server 26.11.0.
 *
 * It reads health, version, memory and uptime, and the list of budget files: their names, whether
 * they are encrypted and how many people can open them. Never a budget's contents or encryption
 * details, and the password and session never leave this file.
 */

export class ActualError extends Error {}

type Answer = Awaited<ReturnType<Fetch>>;

async function call(
  fetchImpl: Fetch,
  base: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Answer> {
  try {
    return await fetchImpl(joinUrl(base, path), {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `Actual did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const json = async <T>(res: Answer): Promise<T> => {
  const text = (await res.text?.()) ?? "";
  return (text ? JSON.parse(text) : undefined) as T;
};

/** Sessions by server and password fingerprint, so a changed password signs in afresh. */
const SESSIONS = new Map<string, string>();
const keyOf = (base: string, password: string) =>
  `${base}#${createHash("sha256").update(password).digest("hex").slice(0, 16)}`;

async function signIn(fetchImpl: Fetch, base: string, password: string): Promise<string> {
  const res = await call(
    fetchImpl,
    base,
    "POST",
    "/account/login",
    {},
    { loginMethod: "password", password },
  );
  const body = await json<{ status?: string; reason?: string; data?: { token?: string } }>(
    res,
  ).catch(() => undefined);
  if (body?.data?.token) return body.data.token;
  if (res.status === 400 || res.status === 401 || body?.reason === "invalid-password")
    throw new AppKeyError("Actual refused the server password. Check the password in the vault.");
  throw new ActualError(
    `Actual could not sign in: ${redactLine(body?.reason ?? `answer ${res.status}`)}.`,
  );
}

async function signedGet<T>(
  fetchImpl: Fetch,
  base: string,
  password: string,
  path: string,
): Promise<T> {
  const k = keyOf(base, password);
  for (let attempt = 0; attempt < 2; attempt++) {
    let token = SESSIONS.get(k);
    if (!token) {
      token = await signIn(fetchImpl, base, password);
      SESSIONS.set(k, token);
    }
    const res = await call(fetchImpl, base, "GET", path, { "x-actual-token": token });
    const body = await json<{ status?: string; reason?: string; data?: unknown }>(res).catch(
      () => undefined,
    );
    // An expired or forgotten session answers 401 or "unauthorized": sign in once more.
    if (res.status === 401 || body?.reason === "unauthorized" || body?.reason === "token-expired") {
      SESSIONS.delete(k);
      continue;
    }
    if (!res.ok || body?.status !== "ok")
      throw new ActualError(
        `Actual refused GET ${path}: ${redactLine(body?.reason ?? `answer ${res.status}`)}.`,
      );
    return body.data as T;
  }
  throw new AppKeyError(
    "Actual keeps refusing the session. Check the server password in the vault.",
  );
}

interface RawFile {
  fileId: string;
  name?: string;
  deleted?: number | boolean;
  encryptKeyId?: string | null;
  usersWithAccess?: unknown[];
}

export async function actualDashboard(
  fetchImpl: Fetch,
  base: string,
  password: string,
): Promise<ActualDashboard> {
  const [health, info, metrics, boot, methods] = await Promise.all([
    call(fetchImpl, base, "GET", "/health").then((r) =>
      json<{ status?: string }>(r).catch(() => ({}) as { status?: string }),
    ),
    call(fetchImpl, base, "GET", "/info").then((r) =>
      json<{ build?: { version?: string } }>(r).catch(
        () => ({}) as { build?: { version?: string } },
      ),
    ),
    call(fetchImpl, base, "GET", "/metrics").then((r) =>
      r.ok
        ? json<{ mem?: { rss?: number }; uptime?: number }>(r).catch(
            () => ({}) as { mem?: { rss?: number }; uptime?: number },
          )
        : ({} as { mem?: { rss?: number }; uptime?: number }),
    ),
    call(fetchImpl, base, "GET", "/account/needs-bootstrap").then((r) =>
      json<{ data?: { bootstrapped?: boolean; multiuser?: boolean } }>(r).catch(
        () => ({}) as { data?: { bootstrapped?: boolean; multiuser?: boolean } },
      ),
    ),
    call(fetchImpl, base, "GET", "/account/login-methods").then((r) =>
      json<{ methods?: { method: string; active?: number; displayName?: string }[] }>(r).catch(
        () => ({}) as { methods?: { method: string; active?: number; displayName?: string }[] },
      ),
    ),
  ]);
  if (boot.data?.bootstrapped === false)
    throw new AppKeyError(
      "Actual has no server password yet. Open Actual once and set one, then save it in the vault.",
    );
  const files = await signedGet<RawFile[]>(fetchImpl, base, password, "/sync/list-user-files");
  const live = (files ?? []).filter((f) => !f.deleted);
  return {
    app: "actual",
    ...(info.build?.version ? { version: info.build.version } : {}),
    healthy: health.status === "UP",
    ...(typeof metrics.uptime === "number" ? { uptime: Math.round(metrics.uptime) } : {}),
    ...(typeof metrics.mem?.rss === "number"
      ? { memoryMb: Math.round(metrics.mem.rss / 1_048_576) }
      : {}),
    loginMethods: (methods.methods ?? [])
      .filter((m) => m.active)
      .map((m) => m.displayName || m.method),
    multiuser: Boolean(boot.data?.multiuser),
    budgets: live.map((f) => ({
      id: f.fileId,
      name: f.name ?? "Untitled",
      encrypted: Boolean(f.encryptKeyId),
      people: (f.usersWithAccess ?? []).length,
    })),
    deleted: (files ?? []).length - live.length,
  };
}

export async function readActual(
  base: string,
  password: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await actualDashboard(fetchImpl, base, password);
  const issues: AppIssue[] = [];
  if (!d.healthy)
    issues.push({
      level: "error",
      key: "unhealthy",
      text: "Actual's server says it is not healthy.",
    });
  return {
    app: "actual",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [{ label: "Budgets", value: String(d.budgets.length) }],
  };
}
