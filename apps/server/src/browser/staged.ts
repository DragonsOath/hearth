import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { JobStepInput } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { isProtectedContainer } from "../admin/scope";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { scrubSecrets } from "./manager";
import type { SessionMaterial } from "./signin";
import { clock } from "../findings/analyzers/types";

/**
 * Held changes from Ember's browser (checklist 45.14, approval scope). When Ember saves something
 * in one of the owner's apps and the change is not allowed yet, the browser does not send it: the
 * exact request is held here, with what it would change (read from the app just before). A plan
 * step names one held change; approving it authorizes that request and nothing else. Running it
 * sends exactly that request once, then reads the app back to verify. So:
 * - approval is not execution (nothing is sent before the step runs),
 * - execution is not verification (the read-back decides "verified"),
 * - another change can never ride on an approval (each is held and approved on its own),
 * - an expired, discarded or already-sent change cannot be sent again,
 * - a restart forgets every held change, so nothing resumes on its own.
 * Raw headers, cookies and bodies stay in memory here; only the summary leaves (secrets hidden).
 */

export interface HeldChange {
  id: string;
  serviceId: string;
  serviceName: string;
  method: string;
  /** Path and query only (no origin), for the summary. */
  path: string;
  changes: { name: string; before: string; after: string }[];
  summary: string;
  at: string;
  expiresAt: string;
}

interface Held extends HeldChange {
  origin: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  cookie?: string;
  authorization?: string;
  hash: string;
  /** The app's values for the changed fields just before it was held (for the stale check). */
  beforeValues: Record<string, unknown>;
  afterValues: Record<string, unknown>;
  /** The app's values could not be read when it was held (no stale check is possible). */
  noBaseline?: boolean;
}

type Fetch = typeof fetch;

const SECRET_KEY = /(api.?key|password|passwd|token|secret|cookie|authorization|credential)/i;
const DROP_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "accept-encoding",
  "cookie",
  "authorization",
]);
const TTL_MS = 30 * 60_000;

/** Flattens JSON to dotted keys (three levels; lists are kept whole), for a field diff. */
function flatten(v: unknown, prefix = "", depth = 0, out: Record<string, unknown> = {}) {
  if (v && typeof v === "object" && !Array.isArray(v) && depth < 3) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      flatten(x, prefix ? `${prefix}.${k}` : k, depth + 1, out);
  } else if (prefix) out[prefix] = v;
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function parseBody(body: string | undefined, type: string | undefined): unknown {
  if (!body) return undefined;
  if (/json/i.test(type ?? "") || /^[[{]/.test(body.trim())) {
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  if (/x-www-form-urlencoded/i.test(type ?? ""))
    return Object.fromEntries(new URLSearchParams(body));
  return undefined;
}

/** "firstDayOfWeek" -> "First Day Of Week". */
const label = (k: string) =>
  k
    .split(".")
    .map((p) =>
      p
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .replace(/^\w/, (c) => c.toUpperCase()),
    )
    .join(" > ");

export class StagedChanges {
  private held = new Map<string, Held>();

  constructor(
    private opts: {
      fetch?: Fetch;
      now?: () => number;
      ttlMs?: number;
      /** Signs in again when the held session has ended (only the session comes back). */
      signIn?: (serviceId: string, origin: string) => Promise<SessionMaterial | undefined>;
      secrets?: (serviceId: string) => Promise<string[]>;
    } = {},
  ) {}

  /** Hooks known only once the app is set up (sign-in, the app's secrets). */
  configure(more: Pick<NonNullable<StagedChanges["opts"]>, "signIn" | "secrets">) {
    this.opts = { ...this.opts, ...more };
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private get fetch(): Fetch {
    return this.opts.fetch ?? fetch;
  }

  private headersOf(h: Held, session?: { cookie?: string; authorization?: string }) {
    return {
      ...h.headers,
      ...((session?.cookie ?? h.cookie) ? { cookie: (session?.cookie ?? h.cookie)! } : {}),
      ...((session?.authorization ?? h.authorization)
        ? { authorization: (session?.authorization ?? h.authorization)! }
        : {}),
    };
  }

  private async read(h: Held, url: string, session?: { cookie?: string; authorization?: string }) {
    const res = await this.fetch(url, {
      headers: { ...this.headersOf(h, session), accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
    if (!res) return { status: 0, json: undefined };
    const json = res.ok ? ((await res.json().catch(() => undefined)) as unknown) : undefined;
    return { status: res.status, json };
  }

  /** Holds a change the page tried to send; returns what it would change (never the raw request). */
  async stage(input: {
    serviceId: string;
    serviceName: string;
    origin: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
    cookie?: string;
    authorization?: string;
  }): Promise<HeldChange> {
    const method = input.method.toUpperCase();
    const headers = Object.fromEntries(
      Object.entries(input.headers).filter(([k]) => !DROP_HEADERS.has(k.toLowerCase())),
    );
    const type = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1];
    const u = new URL(input.url);
    const draft: Held = {
      id: randomUUID().slice(0, 8),
      serviceId: input.serviceId,
      serviceName: input.serviceName,
      origin: input.origin,
      url: input.url,
      method,
      path: `${u.pathname}${u.search}`.slice(0, 200),
      headers,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.cookie ? { cookie: input.cookie } : {}),
      ...(input.authorization ? { authorization: input.authorization } : {}),
      hash: createHash("sha256")
        .update(`${method} ${input.url}\n${input.body ?? ""}`)
        .digest("hex")
        .slice(0, 16),
      changes: [],
      summary: "",
      beforeValues: {},
      afterValues: {},
      at: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + (this.opts.ttlMs ?? TTL_MS)).toISOString(),
    };
    const hide = (await this.opts.secrets?.(input.serviceId).catch(() => [])) ?? [];
    const shown = (k: string, v: unknown) =>
      v === undefined
        ? "(not set)"
        : SECRET_KEY.test(k)
          ? "(hidden)"
          : scrubSecrets(typeof v === "string" ? v : JSON.stringify(v), hide).slice(0, 120);
    const after = flatten(parseBody(input.body, type));
    let before: Record<string, unknown> = {};
    if (method === "PUT" || method === "PATCH" || method === "DELETE") {
      let got = await this.read(draft, input.url);
      if ((got.status === 401 || got.status === 403) && this.opts.signIn)
        got = await this.read(draft, input.url, await this.fresh(draft));
      if (got.json === undefined) draft.noBaseline = true;
      before = flatten(got.json);
    }
    if (method === "DELETE") {
      draft.changes = [{ name: draft.path, before: "exists", after: "deleted" }];
    } else {
      const keys = Object.keys(after).filter((k) => !same(after[k], before[k]));
      for (const k of keys) {
        draft.beforeValues[k] = before[k];
        draft.afterValues[k] = after[k];
      }
      draft.changes = keys.slice(0, 20).map((k) => ({
        name: label(k),
        before:
          method === "POST" ? "(new)" : draft.noBaseline ? "(could not read)" : shown(k, before[k]),
        after: shown(k, after[k]),
      }));
      if (keys.length > 20)
        draft.changes.push({ name: "And more", before: "", after: `${keys.length - 20} more` });
      if (!keys.length && Object.keys(after).length)
        draft.changes = [
          { name: "Fields", before: "as they are", after: "the same values (no change)" },
        ];
      if (!Object.keys(after).length)
        draft.changes = [{ name: draft.path, before: "as it is", after: `${method} sent` }];
    }
    const first = draft.changes
      .slice(0, 3)
      .map((c) => `${c.name}: ${c.before} to ${c.after}`)
      .join("; ");
    draft.summary = `${input.serviceName}: ${first}${draft.changes.length > 3 ? `; and ${draft.changes.length - 3} more` : ""} (${method} ${u.pathname})`;
    this.held.set(draft.id, draft);
    // Old held changes go after a while, so the list stays small.
    for (const [id, h] of this.held)
      if (Date.parse(h.expiresAt) < this.now() - 3_600_000) this.held.delete(id);
    return this.view(draft);
  }

  private view(h: Held): HeldChange {
    return {
      id: h.id,
      serviceId: h.serviceId,
      serviceName: h.serviceName,
      method: h.method,
      path: h.path,
      changes: h.changes,
      summary: h.summary,
      at: h.at,
      expiresAt: h.expiresAt,
    };
  }

  /** Held changes not sent yet, newest first (summaries only). */
  list(serviceId?: string): HeldChange[] {
    return [...this.held.values()]
      .filter((h) => !serviceId || h.serviceId === serviceId)
      .filter((h) => Date.parse(h.expiresAt) > this.now())
      .reverse()
      .map((h) => this.view(h));
  }

  get(id: string): (HeldChange & { hash: string }) | undefined {
    const h = this.held.get(id);
    return h ? { ...this.view(h), hash: h.hash } : undefined;
  }

  discard(id: string) {
    return this.held.delete(id);
  }

  /**
   * Sends one held change, exactly as held, once; then reads the app back. Refused when it is
   * gone, expired, not the one approved (hash), or the app changed those fields since.
   */
  async execute(id: string, hash: string): Promise<StepOutcome> {
    const h = this.held.get(id);
    if (!h)
      return {
        ok: false,
        stale: true,
        result:
          "That held change is no longer here (Hearth restarted, or it was sent or discarded). Nothing was sent; make the change in the page again.",
      };
    if (h.hash !== hash)
      return { ok: false, result: "That held change is not the one approved. Nothing was sent." };
    if (Date.parse(h.expiresAt) <= this.now()) {
      this.held.delete(id);
      return {
        ok: false,
        stale: true,
        result: `That held change expired at ${clock(h.expiresAt)}. Nothing was sent; make it again in the page.`,
      };
    }
    // One send per approval: it is gone from here whatever happens next.
    this.held.delete(id);
    let session: { cookie?: string; authorization?: string } | undefined;
    if (h.method === "PUT" || h.method === "PATCH") {
      let now = await this.read(h, h.url);
      if ((now.status === 401 || now.status === 403) && this.opts.signIn) {
        session = await this.fresh(h);
        now = await this.read(h, h.url, session);
      }
      const cur = flatten(now.json);
      const moved = Object.keys(h.beforeValues).filter((k) => !same(cur[k], h.beforeValues[k]));
      if (now.json !== undefined && !h.noBaseline && moved.length)
        return {
          ok: false,
          stale: true,
          result: `${h.serviceName} changed since this was held (${moved.slice(0, 3).map(label).join(", ")}). Nothing was sent; make the change again.`,
        };
    }
    const send = (s?: typeof session) =>
      this.fetch(h.url, {
        method: h.method,
        headers: this.headersOf(h, s),
        ...(h.body !== undefined ? { body: h.body } : {}),
        signal: AbortSignal.timeout(30_000),
      }).catch((e: unknown) => e as Error);
    let res = await send(session);
    if (!(res instanceof Error) && (res.status === 401 || res.status === 403) && !session) {
      session = await this.fresh(h);
      if (session) res = await send(session);
    }
    if (res instanceof Error)
      return {
        ok: false,
        result: `${h.serviceName} did not answer (${res.message}). It may or may not have changed; Ember reads it to check.`,
      };
    if (!res.ok) {
      const hide = (await this.opts.secrets?.(h.serviceId).catch(() => [])) ?? [];
      const why = scrubSecrets((await res.text().catch(() => "")).slice(0, 200), hide);
      return {
        ok: false,
        result: `${h.serviceName} refused the change (${res.status}${why ? `: ${why.replace(/\s+/g, " ")}` : ""}). Nothing was changed.`,
      };
    }
    // The read-back decides whether it is verified.
    const answer = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    let readUrl: string | undefined = h.url;
    if (h.method === "POST")
      readUrl =
        answer && (typeof answer.id === "number" || typeof answer.id === "string")
          ? `${h.url.split("?")[0]!.replace(/\/$/, "")}/${answer.id}`
          : undefined;
    if (!readUrl)
      return {
        ok: true,
        verified: false,
        result: `Sent to ${h.serviceName}, which accepted it (${res.status}). Hearth could not read it back automatically: Ember checks it in the page.`,
      };
    const back = await this.read(h, readUrl, session);
    if (h.method === "DELETE")
      return back.status === 404
        ? {
            ok: true,
            verified: true,
            result: `${h.path} is deleted in ${h.serviceName} (read back: gone).`,
          }
        : {
            ok: false,
            result: `${h.serviceName} accepted the delete, but ${h.path} still reads back (${back.status}). Not verified.`,
          };
    const got = flatten(back.json);
    if (back.json === undefined)
      return {
        ok: true,
        verified: false,
        result: `Sent to ${h.serviceName}, which accepted it (${res.status}), but reading it back failed (${back.status}). Ember checks it in the page.`,
      };
    const off = Object.keys(h.afterValues).filter((k) => !same(got[k], h.afterValues[k]));
    return off.length
      ? {
          ok: false,
          result: `${h.serviceName} accepted the change, but ${off.slice(0, 3).map(label).join(", ")} ${off.length === 1 ? "does" : "do"} not read back as approved. Not verified.`,
        }
      : {
          ok: true,
          verified: true,
          result: `${h.summary.replace(/ \((?:PUT|PATCH|POST|DELETE) [^)]*\)$/, "")}: sent once and read back from ${h.serviceName}.`,
        };
  }

  private async fresh(h: Held) {
    const m = await this.opts.signIn?.(h.serviceId, h.origin).catch(() => undefined);
    if (!m) return undefined;
    return {
      ...(m.cookies.length
        ? { cookie: m.cookies.map((c) => `${c.name}=${c.value}`).join("; ") }
        : {}),
      ...(m.authorization ? { authorization: m.authorization } : {}),
    };
  }
}

/**
 * The `browser-change` plan step: one held change, shown exactly (each field before and after),
 * approved on its own, sent once by Hearth and read back.
 */
export function browserChangeOperations(handle: DbHandle, staged: StagedChanges) {
  const service = (id: string) =>
    handle.db.select().from(t.services).where(eq(t.services.id, id)).get();
  const refused = (label: string, serviceName: string, why: string): PlannedStep => ({
    label,
    serviceName,
    changes: true,
    policy: "refuse",
    policyReason: why,
  });
  return {
    async plan(step: JobStepInput): Promise<PlannedStep> {
      const s = await service(step.serviceId);
      if (!s)
        return refused("A held change from Ember's browser", step.serviceId, "No such system.");
      const label = `A change in ${s.name}'s web page`;
      const container = s.checkTarget?.startsWith("container:")
        ? s.checkTarget.slice("container:".length)
        : s.name;
      if (isProtectedContainer(container, s.image ?? ""))
        return refused(
          label,
          s.name,
          `${s.name} is a protected system: it is never changed from the browser. Plan the change as a protected step instead.`,
        );
      const id = String(step.params?.staged ?? "").trim();
      const h = id ? staged.get(id) : undefined;
      if (!h)
        return refused(
          label,
          s.name,
          id
            ? `No held change "${id}" (it expired, was sent, or Hearth restarted): make the change in the page again, and Hearth holds it.`
            : "Say which held change (params.staged, from the browser's held list).",
        );
      if (h.serviceId !== s.id)
        return refused(label, s.name, `Held change ${id} is for ${h.serviceName}, not ${s.name}.`);
      if (Date.parse(h.expiresAt) <= Date.now())
        return refused(label, s.name, `Held change ${id} expired: make it again in the page.`);
      return {
        label: `Send this change to ${s.name}, held from its web page: ${h.summary}`,
        serviceName: s.name,
        changes: true,
        policy: "approve-first",
        policyReason: `Exactly this one request, held by Ember's browser at ${h.at.slice(11, 16)} UTC: Hearth sends it once after you approve, then reads ${s.name} back. Nothing else is allowed by it.`,
        params: { staged: h.id, hash: h.hash },
        change: { summary: h.summary, settings: h.changes },
      };
    },
    async run(step: StepRun): Promise<StepOutcome> {
      return staged.execute(String(step.params?.staged ?? ""), String(step.params?.hash ?? ""));
    },
  };
}
