import type {
  AppIssue,
  AppReport,
  StepParams,
  WizarrDashboard,
  WizarrInvite,
} from "@dragon-control/core";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import type { CredentialBroker } from "../credentials/broker";
import { recordAudit } from "../store/audit";
import type { DbHandle } from "../db/client";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";
import { planSetup, runSetup, WizarrAdminSessions } from "./wizarr-setup";

/**
 * Wizarr (invitations to a media server) through its own API (/api, X-API-Key): users and when
 * their access ends, invitations with their links, servers and libraries. Changes are plan steps you
 * approve and Hearth reads back: create an invitation, delete one nobody used, and a person's access
 * (disable, enable, extend, set or clear its end date, remove). Password resets and Wizarr's API keys
 * are credentials and stay in Wizarr. Its invite steps and General settings are not in its API:
 * wizarr-admin.ts reaches them with its admin sign-in.
 */

type Report = Omit<AppReport, "serviceId" | "checkedAt">;

interface RawInvite {
  id: number;
  code: string;
  url?: string;
  status?: string;
  created?: string | null;
  expires?: string | null;
  used_at?: string | null;
  used_by?: string | null;
  duration?: string | null;
  specific_libraries?: number[];
  server_names?: string[];
}
interface RawUser {
  id: number;
  username?: string;
  email?: string | null;
  server?: string | null;
  server_type?: string | null;
  expires?: string | null;
  created_at?: string | null;
}
interface RawServer {
  id: number;
  name: string;
  server_type?: string;
  verified?: boolean;
  external_url?: string | null;
  allow_downloads?: boolean;
  allow_live_tv?: boolean;
  allow_mobile_uploads?: boolean;
}
interface RawLibrary {
  id: number;
  name: string;
  server_id?: number | null;
  enabled?: boolean;
}

/** One call to Wizarr's API with its key (the caller holds the key only for this call). */
export async function wizarrCall<T>(
  fetchImpl: Fetch,
  base: string,
  key: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T }> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, path), {
      method,
      headers: {
        "X-API-Key": key,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `Wizarr did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (res.status === 401 || res.status === 403)
    throw new AppKeyError(
      "Wizarr refused the API key. Make a new one in Wizarr and paste it again.",
    );
  const data = (await res.json().catch(() => undefined)) as T;
  return { ok: res.ok, status: res.status, data };
}

/** Wizarr writes some times with a zone and some without; those without are UTC. */
const iso = (v?: string | null) => {
  if (!v) return undefined;
  const t = Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};
const DAY = 86_400_000;

/** Wizarr gives a bare /j/CODE when it does not know its own address: Hearth adds one. */
const fullLink = (url: string | undefined, linkBase: string) =>
  !url
    ? ""
    : /^https?:\/\//i.test(url)
      ? url
      : `${linkBase.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;

function toInvite(i: RawInvite, linkBase: string): WizarrInvite {
  return {
    id: i.id,
    code: i.code,
    url: fullLink(i.url, linkBase),
    status: i.status ?? "pending",
    ...(iso(i.created) ? { created: iso(i.created) } : {}),
    ...(iso(i.expires) ? { expires: iso(i.expires) } : {}),
    ...(iso(i.used_at) ? { usedAt: iso(i.used_at) } : {}),
    ...(i.used_by ? { usedBy: i.used_by } : {}),
    duration: i.duration ?? "unlimited",
    servers: i.server_names ?? [],
    libraries: i.specific_libraries ?? [],
  };
}

/** Everything the Wizarr panel shows, read now. */
export async function wizarrDashboard(
  fetchImpl: Fetch,
  base: string,
  key: string,
  now = Date.now(),
  /** The address people reach Wizarr at (the service's public address in Hearth), if known. */
  publicUrl?: string | null,
): Promise<WizarrDashboard> {
  const get = async <T>(path: string): Promise<T> => {
    const r = await wizarrCall<T>(fetchImpl, base, key, "GET", path);
    if (!r.ok) throw new AppUnreachableError(`Wizarr answered ${r.status} for ${path}.`);
    return r.data;
  };
  const [invites, users, servers, libraries] = await Promise.all([
    get<{ invitations?: RawInvite[] }>("/api/invitations"),
    get<{ users?: RawUser[] }>("/api/users"),
    get<{ servers?: RawServer[] }>("/api/servers"),
    get<{ libraries?: RawLibrary[] }>("/api/libraries").catch(() => ({ libraries: [] })),
  ]);
  const inv = (invites.invitations ?? [])
    .map((i) => toInvite(i, publicUrl || base))
    .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
  const us = (users.users ?? []).map((u) => ({
    id: u.id,
    username: u.username ?? `User ${u.id}`,
    ...(u.email ? { email: u.email } : {}),
    ...(u.server ? { server: u.server } : {}),
    ...(u.server_type ? { serverType: u.server_type } : {}),
    ...(iso(u.expires) ? { expires: iso(u.expires) } : {}),
    ...(iso(u.created_at) ? { created: iso(u.created_at) } : {}),
  }));
  const raw = invites.invitations ?? [];
  return {
    app: "wizarr",
    // Where invitation links come from: Wizarr itself, Hearth's public address, or only the local one.
    links: raw.some((i) => i.url && !/^https?:\/\//i.test(i.url))
      ? publicUrl
        ? "public"
        : "local"
      : "wizarr",
    totals: {
      users: us.length,
      invites: inv.length,
      pending: inv.filter((i) => i.status === "pending").length,
      expired: inv.filter((i) => i.status === "expired").length,
      // Access ending within a week, not already ended.
      expiringSoon: us.filter((u) => {
        const t = u.expires ? Date.parse(u.expires) : NaN;
        return t > now && t - now < 7 * DAY;
      }).length,
    },
    invites: inv,
    users: us,
    servers: (servers.servers ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      type: s.server_type ?? "server",
      verified: s.verified !== false,
      ...(s.external_url ? { externalUrl: s.external_url } : {}),
      allowDownloads: Boolean(s.allow_downloads),
      allowLiveTv: Boolean(s.allow_live_tv),
      allowMobileUploads: Boolean(s.allow_mobile_uploads),
    })),
    libraries: (libraries.libraries ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      serverId: l.server_id ?? 0,
      enabled: l.enabled !== false,
    })),
  };
}

/** Wizarr's health for the monitor: who has access, and whose access ends soon. */
export async function readWizarr(base: string, key: string, fetchImpl: Fetch): Promise<Report> {
  const d = await wizarrDashboard(fetchImpl, base, key);
  const issues: AppIssue[] = [];
  const unverified = d.servers.filter((s) => !s.verified);
  if (unverified.length)
    issues.push({
      level: "warning",
      key: "servers",
      text: `Wizarr cannot reach ${unverified.map((s) => s.name).join(", ")}: invitations to it will not work.`,
    });
  return {
    app: "wizarr",
    status: issues.length ? "attention" : "ok",
    issues,
    facts: [
      { label: "Users", value: `${d.totals.users}` },
      { label: "Invitations waiting", value: `${d.totals.pending}` },
      { label: "Access ending this week", value: `${d.totals.expiringSoon}` },
    ],
    queue: [],
    activity: d.invites
      .filter((i) => i.usedAt)
      .slice(0, 5)
      .map((i) => ({
        at: i.usedAt,
        text: `${i.usedBy ?? "Someone"} joined with invitation ${i.code}`,
      })),
    connections: d.servers.map((s) => ({
      name: s.name,
      ok: s.verified,
      detail: s.verified ? "Connected" : "Not reachable",
    })),
  };
}

const LINK_EXPIRY = [1, 7, 30];
const csv = (v: unknown) =>
  typeof v === "string" && v.trim()
    ? v
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
    : [];

const USER_OPS = ["disable", "enable", "extend", "end-date", "no-end", "remove"] as const;
type UserOp = (typeof USER_OPS)[number];
const ADMIN_NOTE =
  "Wizarr cannot tell whether this is the media server's own administrator account. Check it is not: for Jellyfin and Emby that account would be locked out or deleted too.";
/** A day as YYYY-MM-DD in this machine's time zone (the one end dates are chosen in). */
const localDay = (e: string) => {
  const d = new Date(e);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const ends = (e?: string) => (e ? `ends ${localDay(e)}` : "no end date");
/** The end of a day (YYYY-MM-DD) in this machine's time zone. */
const endOfDay = (date: string) => new Date(`${date}T23:59:00`).toISOString();

/** Someone's access, planned from what Wizarr lists now. */
function planUser(
  d: WizarrDashboard,
  service: { name: string },
  params: StepParams | undefined,
  base: PlannedStep,
  now = Date.now(),
): PlannedStep {
  const user = d.users.find((u) => u.id === Number(params?.userId));
  if (!user) throw new Error(`Wizarr has no user #${params?.userId ?? "?"}.`);
  const op = String(params?.op ?? "") as UserOp;
  if (!USER_OPS.includes(op)) throw new Error(`Say what to do: ${USER_OPS.join(", ")}.`);
  const who = `${user.username}${user.server ? ` on ${user.server}` : ""}`;
  const out: StepParams = {
    userId: user.id,
    op,
    username: user.username,
    from: user.expires ?? "",
  };
  let summary: string;
  const settings: { name: string; before: string; after: string }[] = [];
  if (op === "extend") {
    const days = Number(params?.durationDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650)
      throw new Error("Extend by a whole number of days, 1 to 3650.");
    const from = user.expires && Date.parse(user.expires) > now ? Date.parse(user.expires) : now;
    out.durationDays = days;
    summary = `Extend ${who}'s access by ${days} day${days === 1 ? "" : "s"}`;
    settings.push({
      name: "Access",
      before: ends(user.expires),
      after: `about ${ends(new Date(from + days * DAY).toISOString())}`,
    });
  } else if (op === "end-date") {
    const date = String(params?.endDate ?? "");
    const t = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(endOfDay(date)) : NaN;
    if (Number.isNaN(t) || t <= now)
      throw new Error("The end date must be a day in the future (YYYY-MM-DD).");
    out.endDate = date;
    summary = `End ${who}'s access on ${date}`;
    settings.push(
      { name: "Access", before: ends(user.expires), after: `ends ${date}` },
      {
        name: "On that day",
        before: "",
        after:
          "Wizarr ends their access the way its expiry setting says (disable or delete the account).",
      },
    );
  } else if (op === "no-end") {
    if (!user.expires) throw new Error(`${user.username}'s access already has no end date.`);
    summary = `Remove the end date of ${who}'s access`;
    settings.push({ name: "Access", before: ends(user.expires), after: "no end date" });
  } else if (op === "remove") {
    summary = `Remove ${who}`;
    settings.push(
      {
        name: user.username,
        before: "has access",
        after: `removed from Wizarr and their account deleted on ${user.server ?? "the media server"}`,
      },
      { name: "Check first", before: "", after: ADMIN_NOTE },
    );
  } else {
    summary = `${op === "disable" ? "Disable" : "Enable"} ${who}'s account`;
    settings.push({
      name: user.username,
      before: "",
      after: op === "disable" ? "cannot sign in or play until enabled again" : "can sign in again",
    });
    if (op === "disable") settings.push({ name: "Check first", before: "", after: ADMIN_NOTE });
  }
  return {
    ...base,
    label: `${summary} in ${service.name}`,
    serviceName: service.name,
    params: out,
    change: { summary, settings },
  };
}

/** Creating and deleting invitations: planned from what Wizarr says now, read back after. */
export class WizarrOperations {
  private readonly admin: WizarrAdminSessions;

  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {
    this.admin = new WizarrAdminSessions(broker, fetchImpl);
  }

  private use<T>(
    service: { id: string; localUrl: string },
    purpose: string,
    access: "read" | "change",
    fn: (key: string) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value }) => fn(value),
    );
  }

  async plan(
    kind: "app-wizarr-invite" | "app-wizarr-invite-delete" | "app-wizarr-user" | "app-wizarr-setup",
    service: { id: string; name: string; localUrl: string; publicUrl?: string | null },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    // Its setup pages sit behind Wizarr's admin sign-in, which the API key cannot open.
    if (kind === "app-wizarr-setup")
      return this.admin.use(service, "plan a change to Wizarr's setup", "read", (admin) =>
        planSetup(admin, service, params, base),
      );
    const d = await this.use(service, "plan a Wizarr invitation change", "read", (key) =>
      wizarrDashboard(this.fetchImpl, service.localUrl, key, Date.now(), service.publicUrl),
    );
    if (kind === "app-wizarr-user") return planUser(d, service, params, base);
    if (kind === "app-wizarr-invite-delete") {
      const id = Number(params?.invitationId);
      const invite = d.invites.find((i) => i.id === id);
      if (!invite) throw new Error(`Wizarr has no invitation #${params?.invitationId ?? "?"}.`);
      if (invite.status === "used")
        throw new Error(
          `Invitation ${invite.code} was already used by ${invite.usedBy ?? "someone"}; deleting it does not remove their access.`,
        );
      return {
        ...base,
        label: `Delete invitation ${invite.code} in ${service.name}`,
        serviceName: service.name,
        params: { invitationId: invite.id, code: invite.code },
        change: {
          summary: `Delete invitation ${invite.code}`,
          settings: [
            { name: `Invitation ${invite.code}`, before: invite.status, after: "deleted" },
          ],
        },
      };
    }
    const verified = d.servers.filter((s) => s.verified);
    const serverIds = csv(params?.serverIds);
    const chosen = serverIds.length
      ? verified.filter((s) => serverIds.includes(s.id))
      : verified.length === 1
        ? verified
        : [];
    if (!chosen.length)
      throw new Error(
        verified.length
          ? `Say which server the invitation is for: ${verified.map((s) => `${s.name} (${s.id})`).join(", ")}.`
          : "Wizarr has no connected media server to invite people to.",
      );
    const libraryIds = csv(params?.libraryIds);
    // Wizarr keeps only libraries linked to the invitation's server and silently drops the rest,
    // and an invitation left with none gives every library: so only linked ones can be chosen.
    const unlinked = d.libraries.filter((l) => libraryIds.includes(l.id) && l.serverId === 0);
    if (unlinked.length)
      throw new Error(
        `Wizarr has not linked ${unlinked.map((l) => l.name).join(", ")} to a server, so it would ignore that limit and the invitation would give every library. In Wizarr, open Settings, Media servers, edit the server and save it to scan its libraries; then choose them again.`,
      );
    const libs = d.libraries.filter(
      (l) => libraryIds.includes(l.id) && chosen.some((s) => s.id === l.serverId),
    );
    if (libraryIds.length !== libs.length)
      throw new Error("One of those libraries is not in Wizarr for that server.");
    const expiresInDays = params?.expiresInDays === undefined ? 7 : Number(params.expiresInDays);
    if (expiresInDays !== 0 && !LINK_EXPIRY.includes(expiresInDays))
      throw new Error("The link can work for 1, 7, or 30 days, or never expire (0).");
    const durationDays = params?.durationDays === undefined ? 0 : Number(params.durationDays);
    if (!Number.isInteger(durationDays) || durationDays < 0 || durationDays > 3650)
      throw new Error("Access lasts a whole number of days (0 = unlimited).");
    const what = [
      `for ${chosen.map((s) => s.name).join(" and ")}`,
      libs.length ? `libraries: ${libs.map((l) => l.name).join(", ")}` : "all libraries",
      expiresInDays
        ? `link works ${expiresInDays} day${expiresInDays === 1 ? "" : "s"}`
        : "link never expires",
      durationDays ? `access lasts ${durationDays} days` : "access unlimited",
      params?.allowDownloads ? "downloads allowed" : "",
      params?.allowLiveTv ? "live TV allowed" : "",
      params?.allowMobileUploads ? "mobile uploads allowed" : "",
    ].filter(Boolean);
    return {
      ...base,
      label: `Create an invitation in ${service.name} (${what.join("; ")})`,
      serviceName: service.name,
      params: {
        serverIds: chosen.map((s) => s.id).join(","),
        libraryIds: libs.map((l) => l.id).join(","),
        expiresInDays,
        durationDays,
        allowDownloads: Boolean(params?.allowDownloads),
        allowLiveTv: Boolean(params?.allowLiveTv),
        allowMobileUploads: Boolean(params?.allowMobileUploads),
      },
      change: {
        summary: `New invitation ${what[0]}`,
        settings: [{ name: "Invitation", before: "none", after: what.join("; ") }],
      },
    };
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string; publicUrl?: string | null },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    if (step.kind === "app-wizarr-setup")
      return this.admin.use(service, "change Wizarr's setup", "change", (admin) =>
        runSetup(
          admin,
          { handle: this.handle, broker: this.broker, fetchImpl: this.fetchImpl, service },
          step,
        ),
      );
    if (step.kind === "app-wizarr-user")
      return this.use(service, "change someone's access in Wizarr", "change", (key) =>
        this.runUser(step, service, key),
      );
    if (step.kind === "app-wizarr-invite-delete") {
      const id = Number(p.invitationId);
      return this.use(service, "delete a Wizarr invitation", "change", async (key) => {
        const list = await wizarrDashboard(
          this.fetchImpl,
          service.localUrl,
          key,
          Date.now(),
          service.publicUrl,
        );
        const invite = list.invites.find((i) => i.id === id);
        if (!invite) return { ok: true, stale: true, result: "The invitation is already gone." };
        if (invite.status === "used")
          return {
            ok: false,
            stale: true,
            result: `Invitation ${invite.code} was used meanwhile; it was left alone.`,
          };
        const del = await wizarrCall(
          this.fetchImpl,
          service.localUrl,
          key,
          "DELETE",
          `/api/invitations/${id}`,
        );
        if (!del.ok) return { ok: false, result: `Wizarr refused to delete it (${del.status}).` };
        const after = await wizarrDashboard(
          this.fetchImpl,
          service.localUrl,
          key,
          Date.now(),
          service.publicUrl,
        );
        const gone = !after.invites.some((i) => i.id === id);
        await recordAudit(this.handle.db, {
          actor: step.requestedBy,
          action: `Deleted invitation ${invite.code} in ${service.name}`,
          target: `service:${service.id}`,
          detail: { verified: gone },
        });
        return gone
          ? { ok: true, result: `Deleted invitation ${invite.code}; Wizarr no longer lists it.` }
          : { ok: false, result: `Wizarr still lists invitation ${invite.code}.` };
      });
    }
    return this.use(service, "create a Wizarr invitation", "change", async (key) => {
      const before = await wizarrDashboard(
        this.fetchImpl,
        service.localUrl,
        key,
        Date.now(),
        service.publicUrl,
      );
      const expires = Number(p.expiresInDays ?? 7);
      const days = Number(p.durationDays ?? 0);
      const made = await wizarrCall<{
        invitation?: { id?: number; code?: string; url?: string };
        error?: string;
      }>(this.fetchImpl, service.localUrl, key, "POST", "/api/invitations", {
        server_ids: csv(p.serverIds),
        ...(expires ? { expires_in_days: expires } : {}),
        duration: days ? String(days) : "unlimited",
        unlimited: !days,
        library_ids: csv(p.libraryIds),
        allow_downloads: Boolean(p.allowDownloads),
        allow_live_tv: Boolean(p.allowLiveTv),
        allow_mobile_uploads: Boolean(p.allowMobileUploads),
      });
      const created = made.data?.invitation;
      if (!made.ok || !created?.id)
        return {
          ok: false,
          result: `Wizarr did not create it (${made.status}${made.data?.error ? `: ${made.data.error}` : ""}).`,
        };
      const after = await wizarrDashboard(
        this.fetchImpl,
        service.localUrl,
        key,
        Date.now(),
        service.publicUrl,
      );
      const listed = after.invites.find((i) => i.id === created.id);
      // The library limit must have stuck: otherwise whoever uses it may get every library.
      // Wizarr 2.2 saves the limit but its API lists none (an old field), so an empty list cannot
      // confirm it; the plan only allowed libraries Wizarr keeps. Different libraries listed fail.
      const asked = csv(p.libraryIds).sort((a, b) => a - b);
      const got = [...(listed?.libraries ?? [])].sort((a, b) => a - b);
      const libsUnread = asked.length > 0 && got.length === 0;
      const libsOk = libsUnread || asked.join(",") === got.join(",");
      const verified =
        Boolean(listed) && !before.invites.some((i) => i.id === created.id) && libsOk;
      await recordAudit(this.handle.db, {
        actor: step.requestedBy,
        action: `Created invitation ${created.code ?? created.id} in ${service.name}`,
        target: `service:${service.id}`,
        detail: { verified, expiresInDays: expires, durationDays: days },
      });
      return verified
        ? {
            ok: true,
            result: `Created invitation ${listed!.code}. Send this link: ${listed!.url || created.url}${libsUnread ? ". Wizarr does not report an invitation's libraries, so the library limit could not be read back" : ""}`,
          }
        : listed && !libsOk
          ? {
              ok: false,
              result: `Wizarr made invitation ${listed.code}, but lists ${got.length ? `libraries ${got.join(", ")}` : "no library limit"} on it instead of the ${asked.length} chosen. Whoever uses it may get every library: delete it in the Wizarr panel if that is not wanted.`,
            }
          : { ok: false, result: "Wizarr answered, but the new invitation is not in its list." };
    });
  }
  /** Someone's access: changed only if Wizarr still shows what was approved, then read back. */
  private async runUser(
    step: StepRun,
    service: { id: string; name: string; localUrl: string; publicUrl?: string | null },
    key: string,
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const id = Number(p.userId);
    const op = String(p.op) as UserOp;
    const name = String(p.username ?? `user ${id}`);
    const read = () =>
      wizarrDashboard(this.fetchImpl, service.localUrl, key, Date.now(), service.publicUrl);
    const user = (await read()).users.find((u) => u.id === id);
    if (!user)
      return op === "remove"
        ? { ok: true, stale: true, result: `${name} is already gone from Wizarr.` }
        : {
            ok: false,
            stale: true,
            result: `Wizarr no longer lists ${name}; nothing was changed.`,
          };
    // A retry, or a change made meanwhile, must not extend twice or undo someone else's edit.
    if ((user.expires ?? "") !== String(p.from ?? ""))
      return {
        ok: false,
        stale: true,
        result: `${user.username}'s end date changed since this was planned (${ends(user.expires)} now); nothing was changed.`,
      };
    const call = (method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) =>
      wizarrCall<{ message?: string; error?: string; new_expiry?: string }>(
        this.fetchImpl,
        service.localUrl,
        key,
        method,
        `/api/users/${id}${path}`,
        body,
      );
    const r =
      op === "remove"
        ? await call("DELETE", "")
        : op === "disable" || op === "enable"
          ? await call("POST", `/${op}`)
          : op === "extend"
            ? await call("POST", "/extend", { days: Number(p.durationDays) })
            : op === "end-date"
              ? await call("PUT", "/update-expiry", { expires: endOfDay(String(p.endDate)) })
              : await call("PUT", "/update-expiry", {});
    if (!r.ok)
      return {
        ok: false,
        result: `Wizarr refused (${r.status}${r.data?.error ? `: ${r.data.error}` : ""}).`,
      };
    let verified = false;
    let result: string;
    if (op === "disable" || op === "enable") {
      // Wizarr does not report this state: say what it answered, not that it was checked.
      result = `Wizarr says ${user.username} is ${op}d. Wizarr does not show this state, so Hearth could not read it back.`;
    } else {
      const after = (await read()).users.find((u) => u.id === id);
      if (op === "remove") {
        verified = !after;
        result = verified
          ? `Removed ${user.username}; Wizarr no longer lists them.`
          : `Wizarr still lists ${user.username}.`;
      } else if (op === "no-end") {
        verified = Boolean(after) && !after?.expires;
        result = verified
          ? `${user.username}'s access has no end date now (read back).`
          : `Wizarr still lists an end date for ${user.username}.`;
      } else {
        const want = op === "extend" ? iso(r.data?.new_expiry) : endOfDay(String(p.endDate));
        const got = after?.expires;
        verified =
          Boolean(want && got) &&
          Math.abs(Date.parse(got ?? "") - Date.parse(want ?? "")) < 60_000 &&
          (op !== "extend" || !user.expires || Date.parse(got ?? "") > Date.parse(user.expires));
        result = verified
          ? `${user.username}'s access ${ends(got)} (read back).`
          : `Wizarr answered, but lists ${user.username}'s access as ${ends(got)}.`;
      }
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? `Changed ${user.username}'s access`} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, userId: id, verified },
    });
    return { ok: op === "disable" || op === "enable" ? true : verified, result };
  }
}
