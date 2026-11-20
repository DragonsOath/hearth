import type { NavidromeDashboard, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import { NavidromeError, navidromeDashboard, nd, subsonic, type NdLogin } from "./navidrome";

/**
 * Changes in Navidrome, each a plan the owner approves (app-navidrome-control, params.op): scan the
 * library (quick, or full to read every file again), forget files it can no longer find, make a
 * user an administrator or not, and remove a user. Each is read back. Hearth never turns off or
 * removes the administrator it signs in as, and never sets passwords: new users are made in
 * Navidrome.
 */

export const NAVIDROME_OPS = [
  "scan",
  "full-scan",
  "forget-missing",
  "admin-on",
  "admin-off",
  "remove-user",
] as const;
export type NavidromeOp = (typeof NAVIDROME_OPS)[number];

type Service = { id: string; name: string; localUrl: string };

export class NavidromeOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (login: NdLogin) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value, username }) => fn({ username: username ?? "", password: value }),
    );
  }

  async plan(
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as NavidromeOp;
    if (!NAVIDROME_OPS.includes(op))
      throw new Error(`Say what to do: ${NAVIDROME_OPS.join(", ")}.`);
    return this.use(service, "plan a change in Navidrome", "read", async (login) =>
      planNavidrome(
        await navidromeDashboard(this.fetchImpl, service.localUrl, login),
        service.name,
        op,
        params ?? {},
        base,
        login.username,
      ),
    );
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await this.use(service, "change Navidrome", "change", (login) =>
        runNavidrome(this.fetchImpl, service.localUrl, login, p),
      );
    } catch (error) {
      if (!(error instanceof NavidromeError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: p.op, ok: out.ok, userId: p.userId ?? null },
    });
    return out;
  }

  /** Administrator on and off undo each other; the rest stay done. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    const op = String(p.op);
    if (op !== "admin-on" && op !== "admin-off") return undefined;
    return this.use(service, "undo a change in Navidrome", "change", (login) =>
      runNavidrome(this.fetchImpl, service.localUrl, login, {
        ...p,
        op: op === "admin-on" ? "admin-off" : "admin-on",
      }),
    );
  }
}

export function planNavidrome(
  d: NavidromeDashboard,
  name: string,
  op: NavidromeOp,
  p: StepParams,
  base: PlannedStep,
  me: string,
): PlannedStep {
  const step = (
    label: string,
    setting: { name: string; before: string; after: string },
    extra: StepParams = {},
  ): PlannedStep => ({
    ...base,
    label,
    serviceName: name,
    params: { op, ...extra },
    change: { summary: label, settings: [setting] },
  });
  if (op === "scan" || op === "full-scan") {
    if (d.scan.scanning) throw new Error(`${name} is scanning already.`);
    return step(
      op === "scan"
        ? `Scan ${name}'s library for new and changed music`
        : `Scan ${name}'s whole library again, reading every file (slower; picks up changed tags everywhere)`,
      {
        name: "Library",
        before: d.scan.lastScan ? `scanned ${d.scan.lastScan.slice(0, 10)}` : "not scanned",
        after: "scanning",
      },
    );
  }
  if (op === "forget-missing") {
    if (!d.missingCount) throw new Error(`${name} has no missing files.`);
    return step(
      `Forget the ${d.missingCount === 1 ? "file" : `${d.missingCount} files`} ${name} can no longer find (their plays and stars go too; put a file back first if it only moved)`,
      { name: "Missing files", before: String(d.missingCount), after: "0" },
      { ids: d.missing.map((m) => m.id).join(",") },
    );
  }
  const u = d.users.find((x) => x.id === String(p.userId ?? ""));
  if (!u) throw new Error(`${name} has no such user: read the panel again.`);
  const mine = u.userName === me;
  if (op === "admin-on" || op === "admin-off") {
    const on = op === "admin-on";
    if (u.admin === on) throw new Error(`${u.name} is ${on ? "already" : "not"} an administrator.`);
    if (!on && mine) throw new Error(`Hearth signs in as ${u.name}: it stays an administrator.`);
    return step(
      on
        ? `Make ${u.name} an administrator in ${name} (they can manage users and settings)`
        : `Make ${u.name} an ordinary user in ${name}`,
      {
        name: u.name,
        before: u.admin ? "administrator" : "user",
        after: on ? "administrator" : "user",
      },
      { userId: u.id, name: u.name },
    );
  }
  if (mine) throw new Error(`Hearth signs in as ${u.name}: it is not removed.`);
  return step(
    `Remove ${u.name} from ${name} (their playlists, stars and play counts go too; the music stays)`,
    { name: u.name, before: "a user", after: "removed" },
    { userId: u.id, name: u.name },
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runNavidrome(
  fetchImpl: Fetch,
  base: string,
  login: NdLogin,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as NavidromeOp;
  const done = (ok: boolean, yes: string, no: string): StepOutcome => ({
    ok,
    verified: ok,
    result: ok ? yes : no,
  });

  if (op === "scan" || op === "full-scan") {
    const r = await subsonic<{ scanStatus?: { scanning?: boolean; lastScan?: string } }>(
      fetchImpl,
      base,
      login,
      "startScan",
      op === "full-scan" ? { fullScan: "true" } : {},
    );
    const before = r.body.scanStatus?.lastScan;
    // It says it started; a small library may be done before the next read.
    for (let i = 0; i < 10; i++) {
      const s =
        (
          await subsonic<{
            scanStatus?: { scanning?: boolean; lastScan?: string; count?: number };
          }>(fetchImpl, base, login, "getScanStatus")
        ).body.scanStatus ?? {};
      if (!s.scanning && s.lastScan && s.lastScan !== before)
        return { ok: true, verified: true, result: `The scan finished: ${s.count ?? 0} files.` };
      if (s.scanning && i > 2)
        return { ok: true, result: "Navidrome is scanning; new music shows as it goes." };
      await sleep(1000);
    }
    return { ok: true, result: "Navidrome started the scan." };
  }
  if (op === "forget-missing") {
    const ids = String(p.ids ?? "")
      .split(",")
      .filter(Boolean);
    if (!ids.length) return { ok: false, result: "No files were named." };
    await nd(
      fetchImpl,
      base,
      login,
      "DELETE",
      `/api/missing?${ids.map((id) => `id=${encodeURIComponent(id)}`).join("&")}`,
    );
    const left =
      (await nd<{ id: string }[]>(fetchImpl, base, login, "GET", "/api/missing?_end=200")).data ??
      [];
    const still = left.filter((x) => ids.includes(x.id)).length;
    return done(
      still === 0,
      `Navidrome forgot ${ids.length === 1 ? "the missing file" : `${ids.length} missing files`}.`,
      `${still} still listed.`,
    );
  }
  const id = String(p.userId);
  const label = String(p.name ?? id);
  const path = `/api/user/${encodeURIComponent(id)}`;
  let user: Record<string, unknown>;
  try {
    user = (await nd<Record<string, unknown>>(fetchImpl, base, login, "GET", path)).data;
  } catch {
    return { ok: false, stale: true, result: `${label} is no longer in Navidrome.` };
  }
  if (op === "remove-user") {
    await nd(fetchImpl, base, login, "DELETE", path);
    const gone = await nd(fetchImpl, base, login, "GET", path).then(
      () => false,
      () => true,
    );
    return done(gone, `${label} is removed.`, `${label} is still there.`);
  }
  const on = op === "admin-on";
  if ((user.isAdmin === true) === on)
    return {
      ok: false,
      stale: true,
      result: `${label} was ${on ? "already" : "not"} an administrator.`,
    };
  await nd(fetchImpl, base, login, "PUT", path, {
    id,
    userName: user.userName,
    name: user.name,
    email: user.email ?? "",
    isAdmin: on,
  });
  const after = (await nd<{ isAdmin?: boolean }>(fetchImpl, base, login, "GET", path)).data;
  return done(
    (after?.isAdmin === true) === on,
    on ? `${label} is an administrator.` : `${label} is an ordinary user.`,
    "It does not read back as planned.",
  );
}
